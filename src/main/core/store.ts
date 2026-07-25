import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AppSettings,
  ProviderId,
  Project,
  Session,
  Workspace
} from '@shared/types'

const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'google', 'compatible']

interface PersistedState {
  settings: AppSettings
  projects: Project[]
  workspaces: Workspace[]
}

function defaultState(): PersistedState {
  const providers = {} as AppSettings['providers']
  for (const id of PROVIDER_IDS) providers[id] = { id, hasKey: false }
  return {
    settings: {
      providers,
      defaultModel: {
        provider: 'anthropic',
        model: 'claude-opus-5',
        effort: 'high',
        showThinking: true,
        maxTokens: 32_000
      },
      autoApproveBash: false
    },
    projects: [],
    workspaces: []
  }
}

/** Writes via a temp file + rename so a crash mid-write can't truncate state. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export class Store {
  readonly root: string
  readonly worktreeRoot: string
  private sessionDir: string
  private statePath: string
  private keysPath: string
  private state: PersistedState
  /** provider -> encrypted (or plaintext fallback) key blob, base64. */
  private keys: Record<string, string>

  constructor() {
    this.root = app.getPath('userData')
    this.worktreeRoot = join(this.root, 'worktrees')
    this.sessionDir = join(this.root, 'sessions')
    this.statePath = join(this.root, 'state.json')
    this.keysPath = join(this.root, 'keys.json')

    mkdirSync(this.worktreeRoot, { recursive: true })
    mkdirSync(this.sessionDir, { recursive: true })

    const loaded = readJson<Partial<PersistedState>>(this.statePath, {})
    const base = defaultState()
    this.state = {
      settings: { ...base.settings, ...(loaded.settings ?? {}) },
      projects: loaded.projects ?? [],
      workspaces: loaded.workspaces ?? []
    }
    // Backfill any provider added in a later version of the app.
    for (const id of PROVIDER_IDS) {
      if (!this.state.settings.providers[id]) {
        this.state.settings.providers[id] = { id, hasKey: false }
      }
    }
    this.keys = readJson<Record<string, string>>(this.keysPath, {})
    this.syncKeyFlags()
  }

  private persist(): void {
    writeJsonAtomic(this.statePath, this.state)
  }

  private persistKeys(): void {
    writeJsonAtomic(this.keysPath, this.keys)
    this.syncKeyFlags()
    this.persist()
  }

  private syncKeyFlags(): void {
    for (const id of PROVIDER_IDS) {
      const cfg = this.state.settings.providers[id]
      if (cfg) cfg.hasKey = Boolean(this.keys[id])
    }
  }

  // --- settings ----------------------------------------------------------

  getSettings(): AppSettings {
    return structuredClone(this.state.settings)
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = { ...this.state.settings, ...patch }
    this.persist()
    return this.getSettings()
  }

  setProviderBaseUrl(id: ProviderId, baseUrl: string | undefined): void {
    const cfg = this.state.settings.providers[id]
    if (cfg) cfg.baseUrl = baseUrl?.trim() || undefined
    this.persist()
  }

  setFetchedModels(id: ProviderId, models: string[]): void {
    const cfg = this.state.settings.providers[id]
    if (cfg) cfg.fetchedModels = models
    this.persist()
  }

  // --- API keys ----------------------------------------------------------

  /**
   * Keys are encrypted with the OS keychain via safeStorage. If encryption is
   * unavailable (rare — headless Linux without a keyring), we fall back to
   * plaintext and mark the blob so the UI can warn the user.
   */
  setKey(id: ProviderId, key: string): void {
    if (!key) {
      delete this.keys[id]
      this.persistKeys()
      return
    }
    if (safeStorage.isEncryptionAvailable()) {
      this.keys[id] = `enc:${safeStorage.encryptString(key).toString('base64')}`
    } else {
      this.keys[id] = `raw:${Buffer.from(key, 'utf8').toString('base64')}`
    }
    this.persistKeys()
  }

  getKey(id: ProviderId): string {
    const blob = this.keys[id]
    if (!blob) return ''
    try {
      if (blob.startsWith('enc:')) {
        return safeStorage.decryptString(Buffer.from(blob.slice(4), 'base64'))
      }
      return Buffer.from(blob.slice(4), 'base64').toString('utf8')
    } catch {
      return ''
    }
  }

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  // --- projects ----------------------------------------------------------

  listProjects(): Project[] {
    return structuredClone(this.state.projects)
  }

  getProject(id: string): Project | undefined {
    return this.state.projects.find((p) => p.id === id)
  }

  addProject(project: Project): void {
    this.state.projects.push(project)
    this.persist()
  }

  removeProject(id: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== id)
    this.state.workspaces = this.state.workspaces.filter((w) => w.projectId !== id)
    this.persist()
  }

  // --- workspaces --------------------------------------------------------

  listWorkspaces(): Workspace[] {
    return structuredClone(this.state.workspaces)
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.state.workspaces.find((w) => w.id === id)
  }

  addWorkspace(workspace: Workspace): void {
    this.state.workspaces.push(workspace)
    this.persist()
  }

  updateWorkspace(id: string, patch: Partial<Workspace>): Workspace | undefined {
    const existing = this.state.workspaces.find((w) => w.id === id)
    if (!existing) return undefined
    Object.assign(existing, patch, { updatedAt: Date.now() })
    this.persist()
    return structuredClone(existing)
  }

  removeWorkspace(id: string): void {
    this.state.workspaces = this.state.workspaces.filter((w) => w.id !== id)
    this.persist()
    try {
      rmSync(this.sessionPath(id), { force: true })
    } catch {
      /* session file may not exist yet */
    }
  }

  // --- sessions ----------------------------------------------------------

  private sessionPath(workspaceId: string): string {
    return join(this.sessionDir, `${workspaceId}.json`)
  }

  getSession(workspaceId: string): Session {
    return readJson<Session>(this.sessionPath(workspaceId), {
      workspaceId,
      messages: [],
      transcript: []
    })
  }

  saveSession(session: Session): void {
    writeJsonAtomic(this.sessionPath(session.workspaceId), session)
  }
}

let instance: Store | null = null
export function getStore(): Store {
  if (!instance) instance = new Store()
  return instance
}
