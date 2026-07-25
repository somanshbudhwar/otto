import OpenAI from 'openai'
import type { ConversationMessage, StopReason, StreamEvent, ToolSchema } from '@shared/types'
import { describeError, type CompletionRequest, type Provider } from './types'

/**
 * Chat Completions adapter. Used for both the first-party OpenAI provider and
 * every OpenAI-compatible endpoint (Ollama, OpenRouter, Groq, DeepSeek, vLLM,
 * LM Studio) — same wire format, different base URL.
 */

const REASONING = /^(o\d|gpt-5)/

function toTools(tools: ToolSchema[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>
    }
  }))
}

function toMessages(
  system: string,
  messages: ConversationMessage[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system }
  ]

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const text = msg.content
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('')
      const toolCalls = msg.content
        .filter((p) => p.type === 'tool_use')
        .map((p) => {
          const tu = p as { id: string; name: string; input: Record<string, unknown> }
          return {
            id: tu.id,
            type: 'function' as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) }
          }
        })
      if (!text && toolCalls.length === 0) continue
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      })
    } else {
      // Tool results must be their own `tool` messages; free text stays a user turn.
      const texts: string[] = []
      for (const part of msg.content) {
        if (part.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: part.toolUseId, content: part.content })
        } else {
          texts.push(part.text)
        }
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('\n') })
    }
  }
  return out
}

function mapFinish(reason: string | null | undefined): StopReason {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'refusal'
  return 'end_turn'
}

export class OpenAICompatibleProvider implements Provider {
  private client: OpenAI
  private strict: boolean

  /**
   * @param strict when true this is the real OpenAI API and provider-specific
   *   params like `reasoning_effort` are safe to send. Third-party compatible
   *   servers often 400 on unknown fields, so we omit them there.
   */
  constructor(apiKey: string, baseURL: string | undefined, strict: boolean) {
    this.client = new OpenAI({
      apiKey: apiKey || 'not-needed',
      baseURL: baseURL || undefined,
      dangerouslyAllowBrowser: false
    })
    this.strict = strict
  }

  async listModels(): Promise<string[]> {
    const page = await this.client.models.list()
    return page.data.map((m) => m.id).sort()
  }

  async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const { selection } = req
    const model = selection.model
    const isReasoning = REASONING.test(model)

    const body: Record<string, unknown> = {
      model,
      messages: toMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: selection.maxTokens ?? 32_000
    }
    if (req.tools.length) {
      body.tools = toTools(req.tools)
      body.parallel_tool_calls = true
    }
    if (this.strict && isReasoning && selection.effort) {
      // OpenAI accepts low | medium | high; collapse our wider scale into it.
      const effort = selection.effort === 'low' ? 'low' : selection.effort === 'medium' ? 'medium' : 'high'
      body.reasoning_effort = effort
    }

    // Accumulates streamed tool-call fragments, keyed by choice index.
    const pending = new Map<number, { id: string; name: string; args: string }>()
    let finish: string | null | undefined
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
    const textParts: string[] = []

    try {
      const stream = await this.client.chat.completions.create(
        body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: req.signal }
      )

      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage
        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finish = choice.finish_reason

        const delta = choice.delta as
          | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
              reasoning_content?: string
            })
          | undefined
        if (!delta) continue

        if (delta.content) {
          textParts.push(delta.content)
          yield { type: 'text_delta', text: delta.content }
        }
        // DeepSeek-style reasoning traces on compatible endpoints.
        if (delta.reasoning_content) {
          yield { type: 'thinking_delta', text: delta.reasoning_content }
        }

        for (const call of delta.tool_calls ?? []) {
          const idx = call.index ?? 0
          const entry = pending.get(idx) ?? { id: '', name: '', args: '' }
          if (call.id) entry.id = call.id
          if (call.function?.name) entry.name += call.function.name
          if (call.function?.arguments) entry.args += call.function.arguments
          pending.set(idx, entry)
        }
      }

      const rawParts: unknown[] = []
      for (const [, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        if (!entry.name) continue
        let input: Record<string, unknown> = {}
        try {
          input = entry.args ? JSON.parse(entry.args) : {}
        } catch {
          yield {
            type: 'error',
            message: `Model returned malformed JSON arguments for tool "${entry.name}". Raw: ${entry.args.slice(0, 200)}`
          }
          continue
        }
        const id = entry.id || `call_${Math.random().toString(36).slice(2, 12)}`
        rawParts.push({ id, name: entry.name, input })
        yield { type: 'tool_use', id, name: entry.name, input }
      }

      yield {
        type: 'done',
        stopReason: pending.size > 0 ? 'tool_use' : mapFinish(finish),
        usage: {
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens
        }
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
