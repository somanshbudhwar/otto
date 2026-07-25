import type { JSX } from 'react'
import { PROVIDER_LABELS } from '@shared/models'
import type { AppSettings, ModelSelection, ProviderId } from '@shared/types'
import { modelsFor } from '../lib/models'

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'google', 'compatible']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export default function ModelBar({
  model,
  settings,
  onChange
}: {
  model: ModelSelection
  settings: AppSettings | null
  onChange: (next: ModelSelection) => void
}): JSX.Element {
  const options = modelsFor(model.provider, settings)
  const configured = settings?.providers[model.provider]
  const ready = model.provider === 'compatible' ? Boolean(configured?.baseUrl) : configured?.hasKey

  return (
    <>
      <select
        className="select"
        style={{ width: 'auto' }}
        value={model.provider}
        onChange={(e) => {
          const provider = e.target.value as ProviderId
          const first = modelsFor(provider, settings)[0]
          onChange({ ...model, provider, model: first?.id ?? '' })
        }}
      >
        {PROVIDERS.map((id) => (
          <option key={id} value={id}>
            {PROVIDER_LABELS[id]}
          </option>
        ))}
      </select>

      <select
        className="select"
        style={{ width: 'auto', maxWidth: 240 }}
        value={model.model}
        onChange={(e) => onChange({ ...model, model: e.target.value })}
      >
        {options.length === 0 && <option value="">No models — refresh in Settings</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>

      <select
        className="select"
        style={{ width: 'auto' }}
        value={model.effort ?? 'high'}
        title="Reasoning effort"
        onChange={(e) => onChange({ ...model, effort: e.target.value as ModelSelection['effort'] })}
      >
        {EFFORTS.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>

      {!ready && (
        <span className="pill" style={{ color: 'var(--amber)', borderColor: 'var(--amber)' }}>
          {model.provider === 'compatible' ? 'no base URL' : 'no key'}
        </span>
      )}
    </>
  )
}