import type { ProviderId } from '@shared/types'
import { AnthropicProvider } from './anthropic'
import { GoogleProvider } from './google'
import { OpenAICompatibleProvider } from './openai'
import { ProviderError, type Provider } from './types'

export interface ProviderCredentials {
  apiKey: string
  baseUrl?: string
}

export function createProvider(id: ProviderId, creds: ProviderCredentials): Provider {
  switch (id) {
    case 'anthropic':
      if (!creds.apiKey) throw new ProviderError('No Anthropic API key set. Add one in Settings.')
      return new AnthropicProvider(creds.apiKey, creds.baseUrl)

    case 'openai':
      if (!creds.apiKey) throw new ProviderError('No OpenAI API key set. Add one in Settings.')
      return new OpenAICompatibleProvider(creds.apiKey, creds.baseUrl, true)

    case 'google':
      if (!creds.apiKey) throw new ProviderError('No Google API key set. Add one in Settings.')
      return new GoogleProvider(creds.apiKey)

    case 'compatible':
      if (!creds.baseUrl) {
        throw new ProviderError(
          'No base URL set for the OpenAI-compatible provider. Add one in Settings (e.g. http://localhost:11434/v1).'
        )
      }
      // Many local servers (Ollama, LM Studio) need no key at all.
      return new OpenAICompatibleProvider(creds.apiKey, creds.baseUrl, false)

    default:
      throw new ProviderError(`Unknown provider: ${id}`)
  }
}

export { ProviderError }
export type { Provider }
