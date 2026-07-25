import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AssistantMessage,
  AssistantPart,
  Project,
  Session,
  ToolResultPart,
  TranscriptEntry,
  Usage,
  Workspace
} from '@shared/types'
import { createProvider, ProviderError, type ProviderCredentials } from '../providers'
import { buildSystemPrompt } from './prompt'
import { executeTool, ToolError, TOOL_SCHEMAS } from './tools'

/** Hard ceiling on tool round-trips per user turn, to bound runaway loops. */
const MAX_ITERATIONS = 60

export interface RunOptions {
  project: Project
  workspace: Workspace
  session: Session
  userText: string
  credentials: ProviderCredentials
  signal: AbortSignal
  emit: (event: AgentEvent) => void
  confirmBash?: (command: string) => Promise<boolean>
  /** Persist after each step so a crash or quit doesn't lose the transcript. */
  save: (session: Session) => void
}

function entry(kind: 'assistant' | 'thinking' | 'error', text: string): TranscriptEntry {
  return { id: randomUUID(), kind, text, at: Date.now() } as TranscriptEntry
}

export async function runAgentTurn(opts: RunOptions): Promise<void> {
  const { workspace, session, emit, signal } = opts
  const provider = createProvider(workspace.model.provider, opts.credentials)
  const system = buildSystemPrompt(opts.project, workspace)

  // Record the user's turn.
  session.messages.push({ role: 'user', content: [{ type: 'text', text: opts.userText }] })
  const userEntry: TranscriptEntry = {
    id: randomUUID(),
    kind: 'user',
    text: opts.userText,
    at: Date.now()
  }
  session.transcript.push(userEntry)
  emit({ workspaceId: workspace.id, type: 'entry', entry: userEntry })
  opts.save(session)

  const totals: Usage = { inputTokens: 0, outputTokens: 0 }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (signal.aborted) break

    const parts: AssistantPart[] = []
    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = []
    let textEntry: TranscriptEntry | null = null
    let thinkingEntry: TranscriptEntry | null = null
    let textBuffer = ''
    let thinkingBuffer = ''
    let raw: unknown
    let stopReason: string = 'end_turn'
    let failed = false

    const flushText = (): void => {
      if (textBuffer) {
        parts.push({ type: 'text', text: textBuffer })
        textBuffer = ''
      }
    }

    try {
      for await (const event of provider.stream({
        system,
        messages: session.messages,
        tools: TOOL_SCHEMAS,
        selection: workspace.model,
        signal
      })) {
        switch (event.type) {
          case 'text_delta': {
            if (!textEntry) {
              textEntry = entry('assistant', '')
              session.transcript.push(textEntry)
              emit({ workspaceId: workspace.id, type: 'entry', entry: textEntry })
            }
            textBuffer += event.text
            ;(textEntry as { text: string }).text = textBuffer
            emit({
              workspaceId: workspace.id,
              type: 'entry_delta',
              id: textEntry.id,
              text: event.text
            })
            break
          }

          case 'thinking_delta': {
            if (!thinkingEntry) {
              thinkingEntry = entry('thinking', '')
              session.transcript.push(thinkingEntry)
              emit({ workspaceId: workspace.id, type: 'entry', entry: thinkingEntry })
            }
            thinkingBuffer += event.text
            ;(thinkingEntry as { text: string }).text = thinkingBuffer
            emit({
              workspaceId: workspace.id,
              type: 'entry_delta',
              id: thinkingEntry.id,
              text: event.text
            })
            break
          }

          case 'tool_use': {
            flushText()
            if (thinkingBuffer) {
              parts.push({ type: 'thinking', text: thinkingBuffer })
              thinkingBuffer = ''
            }
            parts.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input })
            toolUses.push({ id: event.id, name: event.name, input: event.input })
            break
          }

          case 'done': {
            flushText()
            stopReason = event.stopReason
            raw = event.raw
            if (event.usage) {
              totals.inputTokens = (totals.inputTokens ?? 0) + (event.usage.inputTokens ?? 0)
              totals.outputTokens = (totals.outputTokens ?? 0) + (event.usage.outputTokens ?? 0)
            }
            break
          }

          case 'error': {
            flushText()
            failed = true
            const errEntry = entry('error', event.message)
            session.transcript.push(errEntry)
            emit({ workspaceId: workspace.id, type: 'entry', entry: errEntry })
            break
          }
        }
      }
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : (err as Error).message
      const errEntry = entry('error', message)
      session.transcript.push(errEntry)
      emit({ workspaceId: workspace.id, type: 'entry', entry: errEntry })
      failed = true
    }

    // Record the assistant turn, preserving provider-native content for replay.
    if (parts.length || raw) {
      const assistant: AssistantMessage = { role: 'assistant', content: parts }
      if (raw) {
        assistant.raw = raw
        assistant.rawProvider = workspace.model.provider
      }
      session.messages.push(assistant)
    }
    opts.save(session)

    if (failed || signal.aborted) break

    if (stopReason === 'max_tokens') {
      const warn = entry(
        'error',
        'The model hit its output token limit mid-response. Raise "Max output tokens" in workspace settings, or ask it to continue.'
      )
      session.transcript.push(warn)
      emit({ workspaceId: workspace.id, type: 'entry', entry: warn })
      break
    }

    if (toolUses.length === 0) break

    // Execute every requested tool, then send all results back in one user turn.
    const results: ToolResultPart[] = []
    let touchedFiles = false

    for (const call of toolUses) {
      const toolEntry: TranscriptEntry = {
        id: call.id,
        kind: 'tool',
        name: call.name,
        input: call.input,
        at: Date.now()
      }
      session.transcript.push(toolEntry)
      emit({ workspaceId: workspace.id, type: 'entry', entry: toolEntry })

      let output: string
      let isError = false
      try {
        output = await executeTool(call.name, call.input, {
          root: workspace.path,
          signal,
          confirmBash: opts.confirmBash
        })
      } catch (err) {
        isError = true
        output =
          err instanceof ToolError
            ? `Error: ${err.message}`
            : `Error: ${(err as Error).message ?? String(err)}`
      }

      if (['write_file', 'edit_file', 'bash'].includes(call.name)) touchedFiles = true

      ;(toolEntry as { result?: string; isError?: boolean }).result = output
      ;(toolEntry as { isError?: boolean }).isError = isError
      emit({ workspaceId: workspace.id, type: 'tool_result', id: call.id, result: output, isError })

      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: output || '(no output)',
        isError
      })
    }

    session.messages.push({ role: 'user', content: results })
    opts.save(session)

    if (touchedFiles) emit({ workspaceId: workspace.id, type: 'diff_dirty' })
    if (signal.aborted) break
  }

  if (totals.inputTokens || totals.outputTokens) {
    const usageEntry: TranscriptEntry = {
      id: randomUUID(),
      kind: 'usage',
      usage: totals,
      at: Date.now()
    }
    session.transcript.push(usageEntry)
    emit({ workspaceId: workspace.id, type: 'entry', entry: usageEntry })
  }

  emit({ workspaceId: workspace.id, type: 'diff_dirty' })
  opts.save(session)
}
