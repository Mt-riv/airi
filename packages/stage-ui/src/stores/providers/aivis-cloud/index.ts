import type { ProviderMetadata, VoiceInfo } from '../../providers'

import { fetchAivmModel, pingAivisCloud } from './models'
import { createAivisCloudSpeechProvider } from './speech'
import {
  AIVIS_CLOUD_DEFAULT_BASE_URL,
  AIVIS_CLOUD_DEFAULT_MODEL_UUID,
  AIVIS_CLOUD_DEFAULT_VOICE_ID,
} from './types'

function readString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value.trim() : ''
}

export const aivisCloudProvider: ProviderMetadata = {
  id: 'aivis-cloud',
  category: 'speech',
  tasks: ['text-to-speech', 'tts'],
  nameKey: 'settings.pages.providers.provider.aivis-cloud.title',
  name: 'Aivis Cloud',
  descriptionKey: 'settings.pages.providers.provider.aivis-cloud.description',
  description: 'Aivis Cloud — managed API for AivisSpeech models (api.aivis-project.com)',
  icon: 'i-carbon:cloud-satellite',
  requiresCredentials: true,
  defaultOptions: () => ({
    baseUrl: AIVIS_CLOUD_DEFAULT_BASE_URL,
    modelUuid: AIVIS_CLOUD_DEFAULT_MODEL_UUID,
  }),
  createProvider: async (config) => {
    const baseUrl = readString(config, 'baseUrl') || AIVIS_CLOUD_DEFAULT_BASE_URL
    const apiKey = readString(config, 'apiKey')
    return createAivisCloudSpeechProvider(baseUrl, apiKey)
  },
  capabilities: {
    listModels: async (config) => {
      const modelUuid = readString(config, 'modelUuid') || AIVIS_CLOUD_DEFAULT_MODEL_UUID
      if (!modelUuid)
        return []

      const baseUrl = readString(config, 'baseUrl') || AIVIS_CLOUD_DEFAULT_BASE_URL
      const apiKey = readString(config, 'apiKey')
      try {
        const model = await fetchAivmModel(baseUrl, apiKey || undefined, modelUuid)
        return [{
          id: model.aivm_model_uuid,
          name: model.name,
          provider: 'aivis-cloud',
          description: model.description ?? '',
          contextLength: 0,
          deprecated: false,
        }]
      }
      catch {
        return [{
          id: modelUuid,
          name: `AIVM ${modelUuid.slice(0, 8)}…`,
          provider: 'aivis-cloud',
          description: 'Configured AIVM model UUID (details unavailable).',
          contextLength: 0,
          deprecated: false,
        }]
      }
    },
    listVoices: async (config) => {
      const modelUuid = readString(config, 'modelUuid') || AIVIS_CLOUD_DEFAULT_MODEL_UUID
      if (!modelUuid)
        return []

      // Always expose a "model default" voice so the Playground can fire a
      // request even when the model-details lookup fails (CORS, 404, etc.) —
      // Aivis Cloud `/v1/tts/synthesize` treats speaker_uuid / style_name as
      // optional and falls back to the model's default style.
      const defaultVoice: VoiceInfo = {
        id: AIVIS_CLOUD_DEFAULT_VOICE_ID,
        name: 'Model Default',
        provider: 'aivis-cloud',
        description: 'Default speaker / style of the configured AIVM model.',
        languages: [{ code: 'ja', title: '日本語' }],
      }

      const baseUrl = readString(config, 'baseUrl') || AIVIS_CLOUD_DEFAULT_BASE_URL
      const apiKey = readString(config, 'apiKey')

      try {
        const model = await fetchAivmModel(baseUrl, apiKey || undefined, modelUuid)
        const voices: VoiceInfo[] = [defaultVoice]
        for (const speaker of model.speakers ?? []) {
          for (const style of speaker.styles ?? []) {
            voices.push({
              id: `${speaker.aivm_speaker_uuid}:${style.name}`,
              name: `${speaker.name} (${style.name})`,
              provider: 'aivis-cloud',
              description: `${model.name} — ${speaker.name} / ${style.name}`,
              languages: [{ code: 'ja', title: '日本語' }],
            })
          }
        }
        return voices
      }
      catch (error) {
        console.warn('[aivis-cloud] listVoices: failed to fetch AIVM model details, falling back to default voice', error)
        return [defaultVoice]
      }
    },
  },
  validators: {
    chatPingCheckAvailable: false,
    validateProviderConfig: async (config) => {
      const apiKey = readString(config, 'apiKey')
      if (!apiKey) {
        return {
          errors: [new Error('API Key is required for Aivis Cloud')],
          reason: 'API Key is required for Aivis Cloud',
          valid: false,
        }
      }

      const baseUrl = readString(config, 'baseUrl') || AIVIS_CLOUD_DEFAULT_BASE_URL

      try {
        const result = await pingAivisCloud(baseUrl, apiKey, AbortSignal.timeout(5000))
        if (result.ok)
          return { errors: [], reason: '', valid: true }

        const reason = result.status === 401
          ? 'Aivis Cloud rejected the API key (401).'
          : `Aivis Cloud returned ${result.status}: ${result.message}`
        return {
          errors: [new Error(reason)],
          reason,
          valid: false,
        }
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const reason = `Cannot reach Aivis Cloud at ${baseUrl}: ${message}`
        return {
          errors: [new Error(reason)],
          reason,
          valid: false,
        }
      }
    },
  },
}
