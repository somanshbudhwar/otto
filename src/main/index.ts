import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import type {
  AgentEvent,
  AppSettings,
  ModelSelection,
  Project,
  ProviderId,
  Session,
  UpdateInfo,
  Workspace
} from '@shared/types'
import { runAgentTurn } from './agent/loop'
import {
  commitAll,
  createWorktree,
  currentBranch,
  deleteBranch,
  hasCommits,
  headSha,
  isGitRepo,
  removeWorktree,
  repoRoot,
  slugify,
  workspaceDiff
} from './core/git'
import { getStore } from './core/store'
import { checkForUpdate, startUpdateWatcher } from './core/updates'
import { createProvider } from './providers'

let mainWindow: BrowserWindow | null = null

/** In-flight agent turns, so a workspace can be cancelled independently. */
const running = new Map<string, AbortController>()
/** Bash approvals awaiting a decision from the renderer. */
const pendingBash = new Map<string, (approved: boolean) => void>()

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Otto',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Open target=_blank links in the user's browser, not a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  const store = getStore()

  // --- settings ---
  ipcMain.handle('settings:get', (): AppSettings => store.getSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<AppSettings>) =>
    store.updateSettings(patch)
  )
  ipcMain.handle('settings:encryption', () => store.isEncryptionAvailable())

  // --- providers ---
  ipcMain.handle('providers:setKey', (_e, provider: ProviderId, key: string) => {
    store.setKey(provider, key.trim())
    return store.getSettings()
  })

  ipcMain.handle('providers:setBaseUrl', (_e, provider: ProviderId, baseUrl: string) => {
    store.setProviderBaseUrl(provider, baseUrl)
    return store.getSettings()
  })

  ipcMain.handle('providers:refreshModels', async (_e, provider: ProviderId) => {
    try {
      const cfg = store.getSettings().providers[provider]
      const client = createProvider(provider, {
        apiKey: store.getKey(provider),
        baseUrl: cfg?.baseUrl
      })
      const models = await client.listModels()
      store.setFetchedModels(provider, models)
      return { ok: true, models }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // --- projects ---
  ipcMain.handle('projects:list', (): Project[] => store.listProjects())

  ipcMain.handle('projects:add', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a git repository',
      properties: ['openDirectory'],
      buttonLabel: 'Add project'
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false }

    const picked = result.filePaths[0]
    if (!(await isGitRepo(picked))) {
      return {
        ok: false,
        error: `${basename(picked)} is not a git repository. Run "git init" there first — Otto isolates each task on its own git worktree.`
      }
    }
    const root = await repoRoot(picked)
    if (!(await hasCommits(root))) {
      return {
        ok: false,
        error: `${basename(root)} has no commits yet. Make an initial commit so Otto has a base to branch from.`
      }
    }
    const existing = store.listProjects().find((p) => p.path === root)
    if (existing) return { ok: true, project: existing }

    const project: Project = {
      id: randomUUID(),
      name: basename(root),
      path: root,
      defaultBranch: await currentBranch(root),
      createdAt: Date.now()
    }
    store.addProject(project)
    return { ok: true, project }
  })

  ipcMain.handle('projects:remove', async (_e, id: string) => {
    const project = store.getProject(id)
    if (!project) return
    // Tear down every worktree this project owns before forgetting it.
    for (const ws of store.listWorkspaces().filter((w) => w.projectId === id)) {
      await removeWorktree(project.path, ws.path).catch(() => undefined)
      await deleteBranch(project.path, ws.branch)
    }
    store.removeProject(id)
  })

  // --- workspaces ---
  ipcMain.handle('workspaces:list', (): Workspace[] => store.listWorkspaces())

  ipcMain.handle('workspaces:create', async (_e, projectId: string, name: string) => {
    const project = store.getProject(projectId)
    if (!project) return { ok: false, error: 'Project not found.' }

    const id = randomUUID()
    const label = name.trim() || 'New task'
    const branch = `otto/${slugify(label)}-${id.slice(0, 6)}`
    const path = join(store.worktreeRoot, projectId, id)

    try {
      const baseSha = await headSha(project.path)
      await createWorktree({ repoPath: project.path, worktreePath: path, branch, baseSha })

      const workspace: Workspace = {
        id,
        projectId,
        name: label,
        path,
        branch,
        baseSha,
        status: 'idle',
        model: store.getSettings().defaultModel,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.addWorkspace(workspace)
      return { ok: true, workspace }
    } catch (err) {
      return { ok: false, error: `Could not create worktree: ${(err as Error).message}` }
    }
  })

  ipcMain.handle('workspaces:remove', async (_e, id: string) => {
    const workspace = store.getWorkspace(id)
    if (!workspace) return
    running.get(id)?.abort()
    running.delete(id)
    const project = store.getProject(workspace.projectId)
    if (project) {
      await removeWorktree(project.path, workspace.path).catch(() => undefined)
      await deleteBranch(project.path, workspace.branch)
    }
    store.removeWorkspace(id)
  })

  ipcMain.handle('workspaces:setModel', (_e, id: string, model: ModelSelection) =>
    store.updateWorkspace(id, { model })
  )

  ipcMain.handle('workspaces:open', async (_e, id: string) => {
    const workspace = store.getWorkspace(id)
    if (workspace) await shell.openPath(workspace.path)
  })

  // --- session ---
  ipcMain.handle('session:get', (_e, workspaceId: string): Session =>
    store.getSession(workspaceId)
  )

  ipcMain.handle('session:clear', (_e, workspaceId: string): Session => {
    const fresh: Session = { workspaceId, messages: [], transcript: [] }
    store.saveSession(fresh)
    return fresh
  })

  // --- agent ---
  ipcMain.handle('agent:send', async (_e, workspaceId: string, text: string) => {
    if (running.has(workspaceId)) {
      return { ok: false, error: 'This workspace is already running. Stop it first.' }
    }
    const workspace = store.getWorkspace(workspaceId)
    if (!workspace) return { ok: false, error: 'Workspace not found.' }
    const project = store.getProject(workspace.projectId)
    if (!project) return { ok: false, error: 'Project not found.' }

    const controller = new AbortController()
    running.set(workspaceId, controller)

    const emit = (event: AgentEvent): void => send('agent:event', event)
    const settings = store.getSettings()

    store.updateWorkspace(workspaceId, { status: 'running' })
    emit({ workspaceId, type: 'status', status: 'running' })

    const confirmBash = settings.autoApproveBash
      ? undefined
      : (command: string): Promise<boolean> =>
          new Promise<boolean>((resolvePromise) => {
            const requestId = randomUUID()
            pendingBash.set(requestId, resolvePromise)
            send('agent:bashRequest', { requestId, workspaceId, command })
            // If the turn is cancelled while we're waiting, deny and move on.
            controller.signal.addEventListener(
              'abort',
              () => {
                if (pendingBash.delete(requestId)) resolvePromise(false)
              },
              { once: true }
            )
          })

    try {
      await runAgentTurn({
        project,
        workspace,
        session: store.getSession(workspaceId),
        userText: text,
        credentials: {
          apiKey: store.getKey(workspace.model.provider),
          baseUrl: settings.providers[workspace.model.provider]?.baseUrl
        },
        signal: controller.signal,
        emit,
        confirmBash,
        save: (session) => store.saveSession(session)
      })
      return { ok: true }
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      emit({
        workspaceId,
        type: 'entry',
        entry: { id: randomUUID(), kind: 'error', text: message, at: Date.now() }
      })
      return { ok: false, error: message }
    } finally {
      running.delete(workspaceId)
      store.updateWorkspace(workspaceId, { status: 'idle' })
      emit({ workspaceId, type: 'status', status: 'idle' })
    }
  })

  ipcMain.handle('agent:cancel', (_e, workspaceId: string) => {
    running.get(workspaceId)?.abort()
  })

  ipcMain.handle('agent:respondBash', (_e, requestId: string, approved: boolean) => {
    const resolvePromise = pendingBash.get(requestId)
    if (resolvePromise) {
      pendingBash.delete(requestId)
      resolvePromise(approved)
    }
  })

  // --- git ---
  ipcMain.handle('git:diff', async (_e, workspaceId: string) => {
    const workspace = store.getWorkspace(workspaceId)
    if (!workspace) return { ok: false, error: 'Workspace not found.' }
    try {
      return { ok: true, diff: await workspaceDiff(workspace.path, workspace.baseSha) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:commit', async (_e, workspaceId: string, message: string) => {
    const workspace = store.getWorkspace(workspaceId)
    if (!workspace) return { ok: false, error: 'Workspace not found.' }
    try {
      return { ok: true, sha: await commitAll(workspace.path, message) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // --- updates ---
  ipcMain.handle('updates:check', (): Promise<UpdateInfo | null> => checkForUpdate())

  // The renderer only ever passes URLs we handed it, but this handler reaches
  // the OS — constrain it to GitHub over https rather than trust the caller.
  ipcMain.handle('updates:download', async (_e, url: string) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    const host = parsed.hostname.toLowerCase()
    const allowed = host === 'github.com' || host.endsWith('.github.com')
    if (parsed.protocol === 'https:' && allowed) await shell.openExternal(parsed.href)
  })

  ipcMain.handle('updates:skip', (_e, version: string) =>
    store.updateSettings({ skippedVersion: version })
  )
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let stopUpdateWatcher: (() => void) | null = null

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  const store = getStore()
  stopUpdateWatcher = startUpdateWatcher(
    (info) => send('updates:available', info),
    (version) => store.getSettings().skippedVersion === version
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const controller of running.values()) controller.abort()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopUpdateWatcher?.()
  stopUpdateWatcher = null
})
