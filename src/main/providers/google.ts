import { GoogleGenAI } from '@google/genai'
import type { ConversationMessage, StreamEvent, ToolSchema } from '@shared/types'
import { describeError, type CompletionRequest, type Provider } from './types'

/**
 * Gemini adapter. Two shape differences from the other providers matter:
 *  1. Function declarations use an OpenAPI-flavoured schema — plain JSON Schema
 *     with `additionalProperties` etc. is rejected, so schemas are sanitized.
 *  2. Tool results are matched by function *name*, not by call id, so we
 *     resolve each tool_result back to the name of the call it answers.
 */

type GeminiSchema = Record<string, unknown>

/** Converts JSON Schema to the subset Gemini accepts. */
function toGeminiSchema(schema: unknown): GeminiSchema | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const src = schema as Record<string, unknown>
  const out: GeminiSchema = {}

  if (typeof src.type === 'string') out.type = src.type.toUpperCase()
  if (typeof src.description === 'string') out.description = src.description
  if (Array.isArray(src.enum)) out.enum = src.enum.map(String)
  if (Array.isArray(src.required)) out.required = src.required

  if (src.properties && typeof src.properties === 'object') {
    const props: Record<string, GeminiSchema> = {}
    for (const [key, value] of Object.entries(src.properties as Record<string, unknown>)) {
      const converted = toGeminiSchema(value)
      if (converted) props[key] = converted
    }
    out.properties = props
  }
  if (src.items) {
    const items = toGeminiSchema(src.items)
    if (items) out.items = items
  }
  // Everything else (additionalProperties, $schema, default, format keywords
  // Gemini doesn't know) is deliberately dropped.
  return out
}

function toFunctionDeclarations(tools: ToolSchema[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toGeminiSchema(t.parameters) ?? { type: 'OBJECT', properties: {} }
  }))
}

function toContents(messages: ConversationMessage[]): Record<string, unknown>[] {
  // Gemini identifies tool responses by name, so map call id -> name first.
  const nameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const part of msg.content) {
      if (part.type === 'tool_use') nameById.set(part.id, part.name)
    }
  }

  const contents: Record<string, unknown>[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const parts: Record<string, unknown>[] = []
      for (const part of msg.content) {
        if (part.type === 'text') {
          if (part.text.trim()) parts.push({ text: part.text })
        } else if (part.type === 'tool_use') {
          parts.push({ functionCall: { name: part.name, args: part.input ?? {} } })
        }
        // Thought parts are not replayable across turns; drop them.
      }
      if (parts.length) contents.push({ role: 'model', parts })
    } else {
      const parts: Record<string, unknown>[] = []
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text })
        } else {
          parts.push({
            functionResponse: {
              name: nameById.get(part.toolUseId) ?? 'unknown_tool',
              response: part.isError
                ? { error: part.content }
                : { output: part.content }
            }
          })
        }
      }
      if (parts.length) contents.push({ role: 'user', parts })
    }
  }
  return contents
}

export class GoogleProvider implements Provider {
  private ai: GoogleGenAI

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey })
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    const pager = await this.ai.models.list()
    for await (const model of pager) {
      const actions = (model as { supportedActions?: string[] }).supportedActions
      if (actions && !actions.includes('generateContent')) continue
      const name = (model.name ?? '').replace(/^models\//, '')
      if (name) ids.push(name)
    }
    return ids.sort()
  }

  async *stream(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const { selection } = req
    const config: Record<string, unknown> = {
      systemInstruction: req.system,
      abortSignal: req.signal,
      maxOutputTokens: selection.maxTokens ?? 32_000
    }
    if (req.tools.length) {
      config.tools = [{ functionDeclarations: toFunctionDeclarations(req.tools) }]
    }
    if (selection.showThinking) {
      config.thinkingConfig = { includeThoughts: true }
    }

    let sawToolCall = false
    let usage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined

    try {
      const stream = await this.ai.models.generateContentStream({
        model: selection.model,
        contents: toContents(req.messages) as never,
        config: config as never
      })

      for await (const chunk of stream) {
        const meta = (chunk as { usageMetadata?: typeof usage }).usageMetadata
        if (meta) usage = meta

        const parts = chunk.candidates?.[0]?.content?.parts ?? []
        for (const part of parts) {
          const p = part as { text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown } }
          if (p.functionCall?.name) {
            sawToolCall = true
            yield {
              type: 'tool_use',
              // Gemini has no call ids; synthesize one for our own bookkeeping.
              id: `gem_${Math.random().toString(36).slice(2, 12)}`,
              name: p.functionCall.name,
              input: (p.functionCall.args ?? {}) as Record<string, unknown>
            }
          } else if (p.text) {
            if (p.thought) yield { type: 'thinking_delta', text: p.text }
            else yield { type: 'text_delta', text: p.text }
          }
        }
      }

      yield {
        type: 'done',
        stopReason: sawToolCall ? 'tool_use' : 'end_turn',
        usage: {
          inputTokens: usage?.promptTokenCount,
          outputTokens: usage?.candidatesTokenCount
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
