import type { ModelInfo, ProviderId } from './types'

/**
 * Built-in model catalog. This is a starting list, not a source of truth —
 * every provider panel has a "Refresh from API" button that queries the
 * provider's own /models endpoint, so newly released models show up without
 * an app update.
 */
export const BUILTIN_MODELS: ModelInfo[] = [
  // --- Anthropic ---------------------------------------------------------
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    provider: 'anthropic',
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: true,
    notes: 'Best default for agentic coding. Thinking is on by default.'
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'anthropic',
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: true,
    notes: 'Near-Opus quality on coding at lower cost.'
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'anthropic',
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: true
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    provider: 'anthropic',
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: true
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    context: 200_000,
    maxOutput: 64_000,
    notes: 'Fastest and cheapest; good for small scoped edits.'
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    provider: 'anthropic',
    context: 1_000_000,
    maxOutput: 128_000,
    reasoning: true,
    notes: 'Highest capability tier. Thinking is always on; premium pricing.'
  },

  // --- OpenAI ------------------------------------------------------------
  { id: 'gpt-5.1', label: 'GPT-5.1', provider: 'openai', reasoning: true },
  { id: 'gpt-5', label: 'GPT-5', provider: 'openai', reasoning: true },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', reasoning: true },
  { id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai' },
  { id: 'o4-mini', label: 'o4-mini', provider: 'openai', reasoning: true },

  // --- Google ------------------------------------------------------------
  {
    id: 'gemini-3-pro-preview',
    label: 'Gemini 3 Pro',
    provider: 'google',
    reasoning: true
  },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google', reasoning: true },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google', reasoning: true }
]

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  compatible: 'OpenAI-compatible'
}

export const PROVIDER_KEY_HELP: Record<ProviderId, string> = {
  anthropic: 'console.anthropic.com → API keys (starts with sk-ant-)',
  openai: 'platform.openai.com → API keys (starts with sk-)',
  google: 'aistudio.google.com → Get API key',
  compatible:
    'Any OpenAI-compatible endpoint: Ollama, OpenRouter, Groq, DeepSeek, vLLM, LM Studio'
}

/** Models whose API rejects `temperature` / `top_p` / `top_k` outright. */
export function rejectsSamplingParams(model: string): boolean {
  return (
    /^claude-(opus-5|opus-4-7|opus-4-8|sonnet-5|fable-5|mythos-5)/.test(model) ||
    /^(o\d|gpt-5)/.test(model)
  )
}

export function findModel(provider: ProviderId, id: string): ModelInfo | undefined {
  return BUILTIN_MODELS.find((m) => m.provider === provider && m.id === id)
}
