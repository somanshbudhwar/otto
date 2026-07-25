import type { JSX } from 'react'
import { useState } from 'react'
import type { FileDiff, WorkspaceDiff } from '@shared/types'

function FileBlock({ file }: { file: FileDiff }): JSX.Element {
  const [open, setOpen] = useState(true)

  return (
    <div className="file">
      <button className="file-head" onClick={() => setOpen((v) => !v)}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        {/* dir="rtl" keeps the filename visible when the path overflows */}
        <span className="file-path" title={file.path}>
          &#8206;{file.path}
        </span>
        {file.status !== 'modified' && (
          <span className={`badge ${file.status === 'deleted' ? 'deleted' : 'added'}`}>
            {file.status === 'untracked' ? 'new' : file.status}
          </span>
        )}
        {file.additions > 0 && <span className="add-count">+{file.additions}</span>}
        {file.deletions > 0 && <span className="del-count">−{file.deletions}</span>}
      </button>

      {open &&
        (file.skipped ? (
          <div className="tool-body">{file.skipped}</div>
        ) : (
          <div className="diff-lines">
            {file.lines.map((line, i) => (
              <div key={i} className={`diff-line ${line.type}`}>
                {line.type === 'meta' ? (
                  <>
                    <span className="gutter" />
                    <span className="sign" />
                    <span className="code">{line.text}</span>
                  </>
                ) : (
                  <>
                    <span className="gutter">{line.newLine ?? line.oldLine ?? ''}</span>
                    <span className="sign">
                      {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}
                    </span>
                    <span className="code">{line.text || ' '}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  )
}

export default function DiffView({
  diff,
  error
}: {
  diff: WorkspaceDiff | null
  error: string | null
}): JSX.Element {
  if (error) {
    return (
      <div className="scroll">
        <div style={{ padding: 16 }}>
          <div className="note err">{error}</div>
        </div>
      </div>
    )
  }

  if (!diff || diff.files.length === 0) {
    return (
      <div className="empty">
        <div className="empty-inner">
          <p style={{ color: 'var(--text-faint)' }}>
            No changes yet. Edits the agent makes in this worktree show up here as a diff against
            the commit it branched from.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="scroll">
      {diff.files.map((file) => (
        <FileBlock key={file.path} file={file} />
      ))}
    </div>
  )
}