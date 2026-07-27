import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentEvent,
  AppSettings,
  ModelSelection,
  Project,
  TranscriptEntry,
  UpdateInfo,
  Workspace,
  WorkspaceDiff
} from '@shared/types'
import BashPrompt, { type BashRequest } from './components/BashPrompt'
import DiffView from './components/DiffView'
import ModelBar from './components/ModelBar'
import Settings from './components/Settings'
import Transcript from './components/Transcript'
import UpdateToast from './components/UpdateToast'

export default function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)

  const [draft, setDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bashRequest, setBashRequest] = useState<BashRequest | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)

  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId

  const active = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId]
  )
  const activeProject = useMemo(
    () => projects.find((p) => p.id === active?.projectId) ?? null,
    [projects, active]
  )
  const running = active?.status === 'running'

  // --- initial load ------------------------------------------------------

  const reload = useCallback(async (): Promise<void> => {
    const [s, p, w] = await Promise.all([
      window.otto.settings.get(),
      window.otto.projects.list(),
      window.otto.workspaces.list()
    ])
    setSettings(s)
    setProjects(p)
    setWorkspaces(w)
    return
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const refreshDiff = useCallback(async (workspaceId: string): Promise<void> => {
    const result = await window.otto.git.diff(workspaceId)
    if (activeIdRef.current !== workspaceId) return
    if (result.ok) {
      setDiff(result.diff ?? null)
      setDiffError(null)
    } else {
      setDiff(null)
      setDiffError(result.error ?? 'Could not read diff.')
    }
  }, [])

  // Load transcript + diff whenever the selected workspace changes.
  useEffect(() => {
    if (!activeId) {
      setEntries([])
      setDiff(null)
      return
    }
    let cancelled = false
    void window.otto.session.get(activeId).then((session) => {
      if (!cancelled) setEntries(session.transcript)
    })
    void refreshDiff(activeId)
    return () => {
      cancelled = true
    }
  }, [activeId, refreshDiff])

  // --- live agent events -------------------------------------------------

  useEffect(() => {
    const off = window.otto.agent.onEvent((event: AgentEvent) => {
      if (event.type === 'status') {
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === event.workspaceId ? { ...w, status: event.status } : w))
        )
        return
      }

      if (event.type === 'diff_dirty') {
        if (event.workspaceId === activeIdRef.current) void refreshDiff(event.workspaceId)
        return
      }

      // Transcript mutations only apply to the workspace on screen; others are
      // reloaded from disk when the user switches to them.
      if (event.workspaceId !== activeIdRef.current) return

      setEntries((prev) => {
        switch (event.type) {
          case 'entry':
            return [...prev, event.entry]
          case 'entry_delta':
            return prev.map((e) =>
              e.id === event.id && 'text' in e ? { ...e, text: e.text + event.text } : e
            )
          case 'tool_result':
            return prev.map((e) =>
              e.id === event.id && e.kind === 'tool'
                ? { ...e, result: event.result, isError: event.isError }
                : e
            )
          default:
            return prev
        }
      })
    })
    return off
  }, [refreshDiff])

  useEffect(() => window.otto.agent.onBashRequest(setBashRequest), [])

  useEffect(() => window.otto.updates.onAvailable(setUpdate), [])

  // The watcher in main pushes later checks, but its first one races this
  // component mounting its listener — so run one deterministic check here.
  const updateChecked = useRef(false)
  useEffect(() => {
    if (!settings || updateChecked.current) return
    updateChecked.current = true
    const skipped = settings.skippedVersion
    void window.otto.updates.check().then((info) => {
      if (info && info.version !== skipped) setUpdate(info)
    })
  }, [settings])

  // --- actions -----------------------------------------------------------

  const addProject = async (): Promise<void> => {
    const result = await window.otto.projects.add()
    if (result.error) setBanner(result.error)
    else setBanner(null)
    await reload()
  }

  const createWorkspace = async (projectId: string): Promise<void> => {
    const name = window.prompt('What should this task be called?', 'New task')
    if (name === null) return
    const result = await window.otto.workspaces.create(projectId, name)
    if (!result.ok) {
      setBanner(result.error ?? 'Could not create workspace.')
      return
    }
    setBanner(null)
    await reload()
    if (result.workspace) setActiveId(result.workspace.id)
  }

  const removeWorkspace = async (id: string): Promise<void> => {
    const workspace = workspaces.find((w) => w.id === id)
    const ok = window.confirm(
      `Delete "${workspace?.name}"?\n\nThis removes its git worktree and branch, discarding any uncommitted work in it.`
    )
    if (!ok) return
    await window.otto.workspaces.remove(id)
    if (activeId === id) setActiveId(null)
    await reload()
  }

  const removeProject = async (id: string): Promise<void> => {
    const project = projects.find((p) => p.id === id)
    const ok = window.confirm(
      `Remove "${project?.name}" from Otto?\n\nThis deletes its Otto worktrees and branches. Your repository itself is not touched.`
    )
    if (!ok) return
    await window.otto.projects.remove(id)
    setActiveId(null)
    await reload()
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || !active || running) return
    setDraft('')
    const result = await window.otto.agent.send(active.id, text)
    if (!result.ok) setBanner(result.error ?? 'Could not start the agent.')
  }

  const setModel = async (model: ModelSelection): Promise<void> => {
    if (!active) return
    await window.otto.workspaces.setModel(active.id, model)
    setWorkspaces((prev) => prev.map((w) => (w.id === active.id ? { ...w, model } : w)))
  }

  const commit = async (): Promise<void> => {
    if (!active) return
    const message = window.prompt('Commit message', `${active.name}`)
    if (!message) return
    setCommitting(true)
    const result = await window.otto.git.commit(active.id, message)
    setCommitting(false)
    if (!result.ok) setBanner(result.error ?? 'Commit failed.')
    else {
      setBanner(null)
      void refreshDiff(active.id)
    }
  }

  const clearSession = async (): Promise<void> => {
    if (!active) return
    if (!window.confirm('Clear this conversation? The files in the worktree are not changed.')) return
    const session = await window.otto.session.clear(active.id)
    setEntries(session.transcript)
  }

  // --- render ------------------------------------------------------------

  const grouped = projects.map((project) => ({
    project,
    items: workspaces.filter((w) => w.projectId === project.id)
  }))

  return (
    <div className={`app${active ? '' : ' no-diff'}`}>
      {/* ----------------------------------------------------- sidebar */}
      <aside className="pane sidebar">
        <div className="sidebar-drag" />
        <div className="brand">
          <div className="brand-mark">O</div>
          <div className="brand-name">Otto</div>
        </div>

        <div className="scroll">
          {grouped.length === 0 && (
            <div style={{ padding: '4px 14px', color: 'var(--text-faint)', fontSize: 12.5 }}>
              Add a git repository to get started.
            </div>
          )}

          {grouped.map(({ project, items }) => (
            <div className="project" key={project.id}>
              <div className="project-head">
                <span
                  style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={project.path}
                >
                  {project.name}
                </span>
                <button title="New task" onClick={() => createWorkspace(project.id)}>
                  +
                </button>
                <button title="Remove project" onClick={() => removeProject(project.id)}>
                  ×
                </button>
              </div>

              {items.length === 0 && (
                <div style={{ padding: '2px 8px 4px', color: 'var(--text-faint)', fontSize: 12 }}>
                  No tasks yet
                </div>
              )}

              {items.map((workspace) => (
                <button
                  key={workspace.id}
                  className={`ws${workspace.id === activeId ? ' active' : ''}`}
                  onClick={() => setActiveId(workspace.id)}
                >
                  <span className={`dot ${workspace.status}`} />
                  <span className="ws-name" title={workspace.branch}>
                    {workspace.name}
                  </span>
                  <span
                    className="ws-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeWorkspace(workspace.id)
                    }}
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <button className="btn wide" onClick={addProject}>
            + Add project
          </button>
          <button
            className="btn ghost wide"
            style={{ marginTop: 6 }}
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </button>
        </div>
      </aside>

      {/* -------------------------------------------------------- chat */}
      <main className="pane">
        <div className="pane-header">
          {active ? (
            <>
              <span style={{ fontWeight: 600 }}>{active.name}</span>
              <span className="usage" title={active.path}>
                {active.branch}
              </span>
              <div className="spacer" />
              {settings && (
                <ModelBar model={active.model} settings={settings} onChange={setModel} />
              )}
            </>
          ) : (
            <span className="pane-title">Otto</span>
          )}
        </div>

        {banner && (
          <div style={{ padding: '10px 14px 0' }}>
            <div className="note err" style={{ marginBottom: 0 }}>
              {banner}{' '}
              <button className="btn ghost sm" onClick={() => setBanner(null)}>
                dismiss
              </button>
            </div>
          </div>
        )}

        {!active ? (
          <div className="empty">
            <div className="empty-inner">
              <h2>No task selected</h2>
              <p>
                Add a git repository, then create a task. Each task gets its own git worktree and
                branch, so agents work in isolation and you review the result as a diff.
              </p>
              <button className="btn primary" onClick={addProject}>
                Add a project
              </button>
            </div>
          </div>
        ) : (
          <>
            <Transcript entries={entries} running={running} />

            <div className="composer">
              <div className="composer-box">
                <textarea
                  rows={3}
                  value={draft}
                  placeholder={`Describe the change you want in ${activeProject?.name ?? 'this repo'}…`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                <div className="composer-bar">
                  <span className="hint">Enter to send · Shift+Enter for a new line</span>
                  <div className="spacer" />
                  <button className="btn ghost sm" onClick={clearSession} disabled={running}>
                    Clear
                  </button>
                  {running ? (
                    <button
                      className="btn sm danger"
                      onClick={() => window.otto.agent.cancel(active.id)}
                    >
                      Stop
                    </button>
                  ) : (
                    <button className="btn primary sm" onClick={send} disabled={!draft.trim()}>
                      Send
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* -------------------------------------------------------- diff */}
      {active && (
        <section className="pane">
          <div className="pane-header">
            <span className="pane-title">Changes</span>
            {diff && (diff.additions > 0 || diff.deletions > 0) && (
              <span className="diff-summary">
                <span className="add-count">+{diff.additions}</span>{' '}
                <span className="del-count">−{diff.deletions}</span>
              </span>
            )}
            <div className="spacer" />
            <button className="btn ghost sm" onClick={() => window.otto.workspaces.openInEditor(active.id)}>
              Reveal
            </button>
            <button className="btn ghost sm" onClick={() => refreshDiff(active.id)}>
              Refresh
            </button>
            <button
              className="btn sm"
              onClick={commit}
              disabled={committing || !diff || diff.files.length === 0}
            >
              {committing ? 'Committing…' : 'Commit'}
            </button>
          </div>
          <DiffView diff={diff} error={diffError} />
        </section>
      )}

      {settingsOpen && settings && (
        <Settings
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {bashRequest && (
        <BashPrompt
          request={bashRequest}
          onRespond={(approved) => {
            void window.otto.agent.respondBash(bashRequest.requestId, approved)
            setBashRequest(null)
          }}
        />
      )}

      {update && (
        <UpdateToast
          info={update}
          onDismiss={() => setUpdate(null)}
          onSkip={() => {
            void window.otto.updates.skip(update.version)
            setUpdate(null)
          }}
        />
      )}
    </div>
  )
}