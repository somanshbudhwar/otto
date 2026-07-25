/**
 * Canonical types shared between the Electron main process (agent runtime)
 * and the renderer (UI). Kept provider-agnostic on purpose: every provider
 * adapter translates to and from these shapes.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'compatible'

export interface ProviderConfig {
  id: ProviderId
  /** Present only in the renderer as a boolean hint; real keys never leave main. */
  hasKey: boolean
  /** Only meaningful for `compatible` (Ollama, OpenRouter, Groq, vLLM, ...). */
  baseUrl?: string
  /** Models discovered from the provider's /models endpoint, if refreshed. */
  fetchedModels?: string[]
}

export interface ModelInfo {
  id: string
  label: string
  provider: ProviderId
  /** Context window in tokens, when known. */
  context?: number
  /** Max output tokens, when known. */
  maxOutput?: number
  /** Model supports an explicit reasoning/thinking mode. */
  reasoning?: boolean
  notes?: string
}

/** The model a workspace runs against. */
export interface ModelSelection {
  provider: ProviderId
  model: string
  /** Anthropic/OpenAI reasoning effort. Ignored by providers without it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Show reasoning summaries in the transcript where the provider supports it. */
  showThinking?: boolean
  maxTokens?: number
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface TextPart {
  type: 'text'
  text: string
}

export interface ThinkingPart {
  type: 'thinking'
  text: string
}

export interface ToolUsePart {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultPart {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
}

export type AssistantPart = TextPart | ThinkingPart | ToolUsePart
export type UserPart = TextPart | ToolResultPart

export interface UserMessage {
  role: 'user'
  content: UserPart[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantPart[]
  /**
   * The provider's native content array for this turn. Anthropic requires
   * thinking blocks to be echoed back byte-identical, so we replay `raw`
   * verbatim when the next request targets the same provider.
   */
  raw?: unknown
  rawProvider?: ProviderId
}

export type ConversationMessage = UserMessage | AssistantMessage

// ---------------------------------------------------------------------------
// Streaming events (adapter -> agent loop -> renderer)
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error'

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'done'; stopReason: StopReason; usage?: Usage; raw?: unknown }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object describing the tool's parameters. */
  parameters: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Projects & workspaces
// ---------------------------------------------------------------------------

export interface Project {
  id: string
  name: string
  /** Absolute path to the git repository root. */
  path: string
  defaultBranch: string
  createdAt: number
}

export type WorkspaceStatus = 'idle' | 'running' | 'error'

export interface Workspace {
  id: string
  projectId: string
  name: string
  /** Absolute path to this workspace's git worktree. */
  path: string
  branch: string
  /** Commit SHA the worktree branched from; diffs are computed against it. */
  baseSha: string
  status: WorkspaceStatus
  model: ModelSelection
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Transcript (what the UI renders)
// ---------------------------------------------------------------------------

export type TranscriptEntry =
  | { id: string; kind: 'user'; text: string; at: number }
  | { id: string; kind: 'assistant'; text: string; at: number }
  | { id: string; kind: 'thinking'; text: string; at: number }
  | {
      id: string
      kind: 'tool'
      name: string
      input: Record<string, unknown>
      result?: string
      isError?: boolean
      at: number
    }
  | { id: string; kind: 'error'; text: string; at: number }
  | { id: string; kind: 'usage'; usage: Usage; at: number }

/** Everything persisted for one workspace's conversation. */
export interface Session {
  workspaceId: string
  messages: ConversationMessage[]
  transcript: TranscriptEntry[]
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export interface DiffHunkLine {
  type: 'add' | 'del' | 'ctx' | 'meta'
  text: string
  oldLine?: number
  newLine?: number
}

export interface FileDiff {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
  lines: DiffHunkLine[]
  /** Set when the file is binary or too large to render. */
  skipped?: string
}

export interface WorkspaceDiff {
  files: FileDiff[]
  additions: number
  deletions: number
}

// ---------------------------------------------------------------------------
// IPC payloads pushed from main -> renderer
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { workspaceId: string; type: 'entry'; entry: TranscriptEntry }
  | { workspaceId: string; type: 'entry_delta'; id: string; text: string }
  | {
      workspaceId: string
      type: 'tool_result'
      id: string
      result: string
      isError?: boolean
    }
  | { workspaceId: string; type: 'status'; status: WorkspaceStatus }
  | { workspaceId: string; type: 'diff_dirty' }

export interface AppSettings {
  providers: Record<ProviderId, ProviderConfig>
  defaultModel: ModelSelection
  /** Auto-approve bash commands instead of prompting. Off by default. */
  autoApproveBash: boolean
}
