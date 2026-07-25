import { BUILTIN_MODELS } from '@shared/models'
import type { AppSettings, ProviderId } from '@shared/types'

export interface ModelOption {
  id: string
  label: string
  /** True when discovered from the provider's API rather than the built-in list. */
  fetched?: boolean
}

/**
 * Built-in models first (with friendly labels), then anything extra the
 * provider reported when the user hit "Refresh from API". That keeps newly
 * released models reachable without shipping an app update.
 */
export function modelsFor(provider: ProviderId, settings: AppSettings | null): ModelOption[] {
  const builtin = BUILTIN_MODELS.filter((m) => m.provider === provider).map((m) => ({
    id: m.id,
    label: m.label
  }))
  const known = new Set(builtin.map((m) => m.id))
  const fetched = (settings?.providers[provider]?.fetchedModels ?? [])
    .filter((id) => !known.has(id))
    .map((id) => ({ id, label: id, fetched: true }))

  return [...builtin, ...fetched]
}

export function describeModel(provider: ProviderId, id: string): string {
  const found = BUILTIN_MODELS.find((m) => m.provider === provider && m.id === id)
  return found?.label ?? id
}
