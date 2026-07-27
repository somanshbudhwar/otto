import type { JSX } from 'react'
import type { UpdateInfo } from '@shared/types'

interface Props {
  info: UpdateInfo
  /** Hides the toast for this run; it returns on the next check or launch. */
  onDismiss: () => void
  /** Hides it permanently, until a version newer than this one ships. */
  onSkip: () => void
}

/**
 * Otto ships unsigned, so updates can't install themselves — this points the
 * user at the right .dmg and gets out of the way.
 */
export default function UpdateToast({ info, onDismiss, onSkip }: Props): JSX.Element {
  const download = (): void => {
    void window.otto.updates.download(info.downloadUrl)
    onDismiss()
  }

  return (
    <div className="update-toast" role="status">
      <div className="update-head">
        <span className="update-title">Otto {info.version} is available</span>
        <button className="update-close" onClick={onDismiss} title="Remind me later">
          ×
        </button>
      </div>

      <p className="update-body">
        You&rsquo;re on {info.currentVersion}. Drag the new build into Applications to replace
        this one — your projects, keys and conversations stay where they are.
      </p>

      {info.notes && <pre className="update-notes">{info.notes}</pre>}

      <div className="update-actions">
        <button className="btn ghost sm" onClick={onSkip}>
          Skip this version
        </button>
        <div className="spacer" />
        <button className="btn primary sm" onClick={download}>
          Download
        </button>
      </div>
    </div>
  )
}
