import type {
  ConversationMessage,
  ModelSelection,
  StreamEvent,
  ToolSchema
} from '@shared/types'

export interface CompletionRequest {
  system: string
  messages: ConversationMessage[]
  tools: ToolSchema[]
  selection: ModelSelection
  signal: AbortSignal
}

export interface Provider {
  /**
   * Runs one model turn, yielding canonical stream events. Adapters must
   * always terminate with exactly one `done` or `error` event.
   */
  stream(req: CompletionRequest): AsyncGenerator<StreamEvent>
  /** Queries the provider's own model list. Used by "Refresh from API". */
  listModels(): Promise<string[]>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Turns an SDK/network error into a message worth showing a human. */
export function describeError(err: unknown): string {
  if (err instanceof ProviderError) return err.message
  const anyErr = err as { status?: number; message?: string; error?: { message?: string } }
  const status = anyErr?.status
  const detail = anyErr?.error?.message || anyErr?.message || String(err)
  if (status === 401) return `Authentication failed — check your API key. (${detail})`
  if (status === 403) return `Permission denied — this key may not have access. (${detail})`
  if (status === 404) return `Model not found — check the model ID. (${detail})`
  if (status === 429) return `Rate limited — wait and retry. (${detail})`
  if (status && status >= 500) return `Provider server error ${status}. Retry shortly. (${detail})`
  return detail
}
