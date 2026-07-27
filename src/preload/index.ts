import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentEvent,
  AppSettings,
  ModelSelection,
  Project,
  ProviderId,
  Session,
  UpdateInfo,
  Workspace,
  WorkspaceDiff
} from '@shared/types'

/**
 * The only surface the renderer can reach. Node stays in the main process;
 * everything here is an explicit, typed IPC call.
 */
const api = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:update', patch),
    encryptionAvailable: (): Promise<boolean> => ipcRenderer.invoke('settings:encryption')
  },

  providers: {
    setKey: (provider: ProviderId, key: string): Promise<AppSettings> =>
      ipcRenderer.invoke('providers:setKey', provider, key),
    setBaseUrl: (provider: ProviderId, baseUrl: string): Promise<AppSettings> =>
      ipcRenderer.invoke('providers:setBaseUrl', provider, baseUrl),
    refreshModels: (
      provider: ProviderId
    ): Promise<{ ok: boolean; models?: string[]; error?: string }> =>
      ipcRenderer.invoke('providers:refreshModels', provider)
  },

  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    add: (): Promise<{ ok: boolean; project?: Project; error?: string }> =>
      ipcRenderer.invoke('projects:add'),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('projects:remove', id)
  },

  workspaces: {
    list: (): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:list'),
    create: (
      projectId: string,
      name: string
    ): Promise<{ ok: boolean; workspace?: Workspace; error?: string }> =>
      ipcRenderer.invoke('workspaces:create', projectId, name),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('workspaces:remove', id),
    setModel: (id: string, model: ModelSelection): Promise<Workspace | undefined> =>
      ipcRenderer.invoke('workspaces:setModel', id, model),
    openInEditor: (id: string): Promise<void> => ipcRenderer.invoke('workspaces:open', id)
  },

  session: {
    get: (workspaceId: string): Promise<Session> => ipcRenderer.invoke('session:get', workspaceId),
    clear: (workspaceId: string): Promise<Session> =>
      ipcRenderer.invoke('session:clear', workspaceId)
  },

  agent: {
    send: (workspaceId: string, text: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('agent:send', workspaceId, text),
    cancel: (workspaceId: string): Promise<void> => ipcRenderer.invoke('agent:cancel', workspaceId),
    /** Answers a pending bash-approval prompt. */
    respondBash: (requestId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke('agent:respondBash', requestId, approved),
    onEvent: (handler: (event: AgentEvent) => void): (() => void) => {
      const listener = (_: unknown, payload: AgentEvent): void => handler(payload)
      ipcRenderer.on('agent:event', listener)
      return () => ipcRenderer.removeListener('agent:event', listener)
    },
    onBashRequest: (
      handler: (payload: { requestId: string; workspaceId: string; command: string }) => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        payload: { requestId: string; workspaceId: string; command: string }
      ): void => handler(payload)
      ipcRenderer.on('agent:bashRequest', listener)
      return () => ipcRenderer.removeListener('agent:bashRequest', listener)
    }
  },

  git: {
    diff: (workspaceId: string): Promise<{ ok: boolean; diff?: WorkspaceDiff; error?: string }> =>
      ipcRenderer.invoke('git:diff', workspaceId),
    commit: (
      workspaceId: string,
      message: string
    ): Promise<{ ok: boolean; sha?: string; error?: string }> =>
      ipcRenderer.invoke('git:commit', workspaceId, message)
  },

  updates: {
    /** Resolves null when up to date, offline, or running in dev. */
    check: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('updates:check'),
    /** Opens the .dmg link in the user's browser. */
    download: (url: string): Promise<void> => ipcRenderer.invoke('updates:download', url),
    /** Suppresses the toast for this version until a newer one ships. */
    skip: (version: string): Promise<AppSettings> => ipcRenderer.invoke('updates:skip', version),
    onAvailable: (handler: (info: UpdateInfo) => void): (() => void) => {
      const listener = (_: unknown, payload: UpdateInfo): void => handler(payload)
      ipcRenderer.on('updates:available', listener)
      return () => ipcRenderer.removeListener('updates:available', listener)
    }
  }
}

contextBridge.exposeInMainWorld('otto', api)

export type OttoApi = typeof api
