import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { PROVIDER_KEY_HELP, PROVIDER_LABELS } from '@shared/models'
import type { AppSettings, ProviderId } from '@shared/types'

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'google', 'compatible']

function ProviderCard({
  id,
  settings,
  onChange
}: {
  id: ProviderId
  settings: AppSettings
  onChange: (next: AppSettings) => void
}): JSX.Element {
  const config = settings.providers[id]
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  const saveKey = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      onChange(await window.otto.providers.setKey(id, key))
      setKey('')
      setStatus({ ok: true, text: 'Key saved.' })
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    onChange(await window.otto.providers.setKey(id, ''))
    setStatus({ ok: true, text: 'Key removed.' })
  }

  const saveBaseUrl = async (): Promise<void> => {
    onChange(await window.otto.providers.setBaseUrl(id, baseUrl))
    setStatus({ ok: true, text: 'Base URL saved.' })
  }

  // Doubles as a credential test: it performs a real authenticated call.
  const refresh = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    const result = await window.otto.providers.refreshModels(id)
    setBusy(false)
    if (result.ok) {
      setStatus({ ok: true, text: `Connected — found ${result.models?.length ?? 0} models.` })
      onChange(await window.otto.settings.get())
    } else {
      setStatus({ ok: false, text: result.error ?? 'Could not reach provider.' })
    }
  }

  return (
    <div className="provider-card">
      <div className="provider-title">
        {PROVIDER_LABELS[id]}
        {config?.hasKey && <span className="pill ok">key set</span>}
        {config?.fetchedModels?.length ? (
          <span className="pill">{config.fetchedModels.length} models</span>
        ) : null}
      </div>

      {id === 'compatible' && (
        <div className="field">
          <label>Base URL</label>
          <div className="row">
            <input
              className="input mono"
              placeholder="http://localhost:11434/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <button className="btn sm" onClick={saveBaseUrl}>
              Save
            </button>
          </div>
          <div className="desc">Must end in /v1 for most servers. Ollama, LM Studio, vLLM, OpenRouter, Groq, DeepSeek.</div>
        </div>
      )}

      <div className="field" style={{ marginBottom: 8 }}>
        <label>API key</label>
        <div className="row">
          <input
            className="input mono"
            type="password"
            placeholder={config?.hasKey ? '•••••••••••••• (stored)' : 'Paste your key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && key) void saveKey()
            }}
          />
          <button className="btn sm" disabled={!key || busy} onClick={saveKey}>
            Save
          </button>
          {config?.hasKey && (
            <button className="btn sm danger" onClick={clearKey}>
              Clear
            </button>
          )}
        </div>
        <div className="desc">{PROVIDER_KEY_HELP[id]}</div>
      </div>

      <div className="row">
        <button className="btn sm" onClick={refresh} disabled={busy}>
          {busy ? 'Testing…' : 'Test & refresh models'}
        </button>
        {status && (
          <span
            className="desc"
            style={{ color: status.ok ? 'var(--green)' : 'var(--red)', marginTop: 0 }}
          >
            {status.text}
          </span>
        )}
      </div>
    </div>
  )
}

export default function Settings({
  settings,
  onChange,
  onClose
}: {
  settings: AppSettings
  onChange: (next: AppSettings) => void
  onClose: () => void
}): JSX.Element {
  const [encrypted, setEncrypted] = useState(true)

  useEffect(() => {
    void window.otto.settings.encryptionAvailable().then(setEncrypted)
  }, [])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {encrypted ? (
            <div className="note" style={{ color: 'var(--text-faint)' }}>
              Keys are encrypted with your OS keychain and stored locally. They are sent only to
              the provider you selected — Otto has no backend.
            </div>
          ) : (
            <div className="note warn">
              OS-level encryption is unavailable on this machine, so keys are stored obfuscated but
              not encrypted. Anyone with access to your user account could read them.
            </div>
          )}

          {PROVIDERS.map((id) => (
            <ProviderCard key={id} id={id} settings={settings} onChange={onChange} />
          ))}

          <div className="field" style={{ marginTop: 18, marginBottom: 0 }}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.autoApproveBash}
                onChange={async (e) => {
                  onChange(
                    await window.otto.settings.update({ autoApproveBash: e.target.checked })
                  )
                }}
              />
              <span>
                Run shell commands without asking
                <div className="desc">
                  Off by default. The agent runs commands inside the workspace worktree, but a
                  command can still reach the network or files elsewhere on your machine.
                </div>
              </span>
            </label>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}