import type { ProviderMetadata, VoiceInfo } from '../../providers'

import {
  AIVISSPEECH_DEFAULT_BASE_URL,
  createVoicevoxSpeechProvider,
  fetchSpeakers,
  VOICEVOX_DEFAULT_BASE_URL,
} from './speech'

export type { VoicevoxSpeechExtraOptions } from './types'

const TRAILING_SLASHES = /\/+$/

/**
 * Build a legacy ProviderMetadata entry for VOICEVOX / AivisSpeech.
 * These engines expose the same REST API, only the default port differs.
 */
function buildVoicevoxProvider(options: {
  id: string
  name: string
  nameKey: string
  descriptionKey: string
  description: string
  defaultBaseUrl: string
}): ProviderMetadata {
  return {
    id: options.id,
    category: 'speech',
    tasks: ['text-to-speech'],
    nameKey: options.nameKey,
    name: options.name,
    descriptionKey: options.descriptionKey,
    description: options.description,
    icon: 'i-carbon:microphone',
    requiresCredentials: false,
    defaultOptions: () => ({
      baseUrl: options.defaultBaseUrl,
    }),
    createProvider: async (config) => {
      const baseUrl = typeof config.baseUrl === 'string' && config.baseUrl.trim().length > 0
        ? config.baseUrl.trim()
        : options.defaultBaseUrl
      return createVoicevoxSpeechProvider(baseUrl)
    },
    capabilities: {
      listModels: async () => {
        // VOICEVOX doesn't have multiple "models" — return a single entry.
        return [
          {
            id: 'voicevox',
            name: options.name,
            provider: options.id,
            description: `${options.name} synthesis engine`,
            contextLength: 0,
            deprecated: false,
          },
        ]
      },
      listVoices: async (config) => {
        const baseUrl = typeof config.baseUrl === 'string' && config.baseUrl.trim().length > 0
          ? config.baseUrl.trim().replace(TRAILING_SLASHES, '')
          : options.defaultBaseUrl

        try {
          const speakers = await fetchSpeakers(baseUrl)
          const voices: VoiceInfo[] = []

          for (const speaker of speakers) {
            for (const style of speaker.styles) {
              voices.push({
                id: String(style.id),
                name: `${speaker.name} (${style.name})`,
                provider: options.id,
                description: `${speaker.name} - ${style.name}`,
                languages: [{ code: 'ja', title: '日本語' }],
              })
            }
          }

          return voices
        }
        catch {
          return []
        }
      },
    },
    validators: {
      chatPingCheckAvailable: false,
      validateProviderConfig: async (config) => {
        const baseUrl = typeof config.baseUrl === 'string' && config.baseUrl.trim().length > 0
          ? config.baseUrl.trim().replace(TRAILING_SLASHES, '')
          : options.defaultBaseUrl

        try {
          const response = await globalThis.fetch(`${baseUrl}/speakers`, {
            signal: AbortSignal.timeout(5000),
          })

          if (!response.ok) {
            return {
              errors: [new Error(`${options.name} server returned ${response.status}`)],
              reason: `${options.name} server returned ${response.status}`,
              valid: false,
            }
          }

          return { errors: [], reason: '', valid: true }
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {
            errors: [new Error(`Cannot reach ${options.name} at ${baseUrl}: ${message}`)],
            reason: `Cannot reach ${options.name} at ${baseUrl}: ${message}`,
            valid: false,
          }
        }
      },
    },
  }
}

export const voicevoxProvider = buildVoicevoxProvider({
  id: 'voicevox',
  name: 'VOICEVOX',
  nameKey: 'settings.pages.providers.provider.voicevox.title',
  descriptionKey: 'settings.pages.providers.provider.voicevox.description',
  description: 'VOICEVOX — 無料の日本語テキスト読み上げソフトウェア',
  defaultBaseUrl: VOICEVOX_DEFAULT_BASE_URL,
})

export const aivisSpeechProvider = buildVoicevoxProvider({
  id: 'aivisspeech',
  name: 'AivisSpeech',
  nameKey: 'settings.pages.providers.provider.aivisspeech.title',
  descriptionKey: 'settings.pages.providers.provider.aivisspeech.description',
  description: 'AivisSpeech — VOICEVOX 互換の高品質日本語 TTS',
  defaultBaseUrl: AIVISSPEECH_DEFAULT_BASE_URL,
})
