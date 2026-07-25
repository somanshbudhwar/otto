import Anthropic from '@anthropic-ai/sdk'
import type {
  AssistantPart,
  ConversationMessage,
  StopReason,
  StreamEvent,
  ToolSchema
} from '@shared/types'
import { describeError, ProviderError, type CompletionRequest, type Provider } from './types'

/**
 * Models that accept `thinking: {type:'adaptive'}` and `output_config.effort`.
 * Older models (Haiku 4.5, Sonnet 4.5 and earlier) reject both, so we omit
 * them rather than sending a parameter that 400s.
 */
const ADAPTIVE = /^claude-(opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-5|sonnet-4-6|fable-5|mythos-5)/

/** `xhigh` landed with Opus 4.7; Opus 4.6 tops out at `high`/`max`. */
function normalizeEffort(model: string, effort?: string): string | undefined {
  if (!effort) return undefined
  if (effort === 'xhigh' && /^claude-opus-4-6/.test(model)) return 'high'
  return effort
}

function toAnthropicTools(tools: ToolSchema[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema
  }))
}

function toAnthropicMessages(messages: ConversationMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // Anthropic requires thinking blocks to be echoed back unmodified, so
      // replay the provider's own content array when we captured it.
      if (msg.rawProvider === 'anthropic' && Array.isArray(msg.raw)) {
        out.push({ role: 'assistant', content: msg.raw as Anthropic.ContentBlockParam[] })
        continue
      }
      const content: Anthropic.ContentBlockParam[] = []
      for (const part of msg.content) {
        if (part.type === 'text') {
          if (part.text.trim()) content.push({ type: 'text', text: part.text })
        } else if (part.type === 'tool_use') {
          content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input })
        }
        // Thinking parts without a signature cannot be replayed; drop them.
      }
      if (content.length) out.push({ role: 'assistant', content })
    } else {
      const content: Anthropic.ContentBlockParam[] = []
      for (const part of msg.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text })
        } else {
          content.push({
            type: 'tool_result',
            tool_use_id: part.toolUseId,
            content: part.content,
            is_error: part.isError
          })
        }
      }
      if (content.length) out.push({ role: 'user', content })
    }
  }
  return out
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

export class AnthropicProvider implements Provider {
  private client: Anthropic

  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, baseURL })
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    for await (const model of this.client.models.list()) ids.push(model.id)
    return ids
  }

  async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const { selection } = req
    const model = selection.model

    // Built as a loose record: the installed SDK's types predate adaptive
    // thinking and `output_config`, though both are accepted on the wire.
    const params: Record<string, unknown> = {
      model,
      max_tokens: selection.maxTokens ?? 32_000,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: toAnthropicTools(req.tools)
    }

    if (ADAPTIVE.test(model)) {
      // Adaptive thinking: Claude decides depth. `budget_tokens` is removed on
      // these models and returns 400, so it is deliberately never sent.
      params.thinking = {
        type: 'adaptive',
        display: selection.showThinking ? 'summarized' : 'omitted'
      }
      const effort = normalizeEffort(model, selection.effort)
      if (effort) params.output_config = { effort }
    }
    // Note: temperature / top_p / top_k are intentionally never sent — the
    // current Opus/Sonnet models reject them outright.

    let stream
    try {
      stream = this.client.messages.stream(params as unknown as Anthropic.MessageStreamParams, {
        signal: req.signal
      })
    } catch (err) {
      yield { type: 'error', message: describeError(err) }
      return
    }

    try {
      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue
        const delta = event.delta
        if (delta.type === 'text_delta') {
          yield { type: 'text_delta', text: delta.text }
        } else if (delta.type === 'thinking_delta') {
          if (delta.thinking) yield { type: 'thinking_delta', text: delta.thinking }
        }
      }

      const final = await stream.finalMessage()

      if (final.stop_reason === 'refusal') {
        const details = (final as { stop_details?: { category?: string } }).stop_details
        yield {
          type: 'error',
          message:
            `The model declined this request` +
            (details?.category ? ` (category: ${details.category}).` : '.') +
            ` Try rephrasing, or switch to a different model in Settings.`
        }
        return
      }

      for (const block of final.content) {
        if (block.type === 'tool_use') {
          yield {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>
          }
        }
      }

      yield {
        type: 'done',
        stopReason: mapStopReason(final.stop_reason),
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
          cacheReadTokens: final.usage.cache_read_input_tokens ?? undefined,
          cacheWriteTokens: final.usage.cache_creation_input_tokens ?? undefined
        },
        raw: final.content
      }
    } catch (err) {
      if (req.signal.aborted) {
        yield { type: 'done', stopReason: 'end_turn' }
        return
      }
      yield { type: 'error', message: describeError(err) }
    }
  }
}

/** Rebuilds canonical assistant parts from Anthropic's native content array. */
export function anthropicContentToParts(content: unknown): AssistantPart[] {
  if (!Array.isArray(content)) return []
  const parts: AssistantPart[] = []
  for (const block of content as Anthropic.ContentBlock[]) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'thinking') parts.push({ type: 'thinking', text: block.thinking })
    else if (block.type === 'tool_use') {
      parts.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>
      })
    }
  }
  return parts
}

export { ProviderError }
