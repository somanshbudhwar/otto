import type { JSX } from 'react'
export interface BashRequest {
  requestId: string
  workspaceId: string
  command: string
}

export default function BashPrompt({
  request,
  onRespond
}: {
  request: BashRequest
  onRespond: (approved: boolean) => void
}): JSX.Element {
  return (
    <div className="overlay">
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <h2>Run this command?</h2>
        </div>
        <div className="modal-body">
          <p style={{ color: 'var(--text-dim)', marginBottom: 12 }}>
            The agent wants to run a shell command in this workspace&rsquo;s worktree.
          </p>
          <div className="cmd-preview">{request.command}</div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => onRespond(false)}>
            Deny
          </button>
          <button className="btn primary" onClick={() => onRespond(true)} autoFocus>
            Run
          </button>
        </div>
      </div>
    </div>
  )
}