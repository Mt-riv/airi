import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import type {
  AivisCloudOutputFormat,
  AivisCloudSynthesizeRequest,
} from './types'

import { AIVIS_CLOUD_DEFAULT_BASE_URL, AIVIS_CLOUD_DEFAULT_VOICE_ID } from './types'

const TRAILING_SLASHES = /\/+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AivisCloudSpeechExtraOptions {
  /** Overrides the `model` positional argument; useful when a single shared model is desired. */
  modelUuid?: string
  speakerUuid?: string
  styleName?: string
  styleId?: number
  speed?: number
  pitch?: number
  volume?: number
  emotionalIntensity?: number
  tempoDynamics?: number
  useSsml?: boolean
  useVolumeNormalizer?: boolean
  outputFormat?: AivisCloudOutputFormat
  outputSamplingRate?: number
  outputBitrate?: number
  outputAudioChannels?: 'mono' | 'stereo'
  userDictionaryUuid?: string
  leadingSilenceSeconds?: number
  trailingSilenceSeconds?: number
  lineBreakSilenceSeconds?: number
}

export function normalizeBaseUrl(value: unknown, defaultUrl: string = AIVIS_CLOUD_DEFAULT_BASE_URL): string {
  let base = typeof value === 'string' ? value.trim() : ''
  if (!base)
    base = defaultUrl
  return base.replace(TRAILING_SLASHES, '')
}

/**
 * Parse a voice id encoded as `"{speakerUuid}:{styleName}"`.
 * Plain UUIDs are treated as speakerUuid-only (default style); plain
 * strings are treated as styleName-only (default speaker of the model).
 */
export function parseVoiceId(voice: string): { speakerUuid?: string, styleName?: string } {
  const value = voice.trim()
  if (!value || value === AIVIS_CLOUD_DEFAULT_VOICE_ID)
    return {}

  const colon = value.indexOf(':')
  if (colon === -1) {
    if (UUID_PATTERN.test(value))
      return { speakerUuid: value }
    return { styleName: value }
  }

  const speakerUuid = value.slice(0, colon).trim() || undefined
  const styleName = value.slice(colon + 1).trim() || undefined
  return { speakerUuid, styleName }
}

interface OpenAITTSLikeBody {
  model?: string
  input?: string
  voice?: string
  // snake_case extras injected by xsai objCamelToSnake
  model_uuid?: string
  speaker_uuid?: string
  style_name?: string
  style_id?: number
  speed?: number
  speaking_rate?: number
  pitch?: number
  volume?: number
  emotional_intensity?: number
  tempo_dynamics?: number
  use_ssml?: boolean
  use_volume_normalizer?: boolean
  response_format?: string
  output_format?: AivisCloudOutputFormat
  output_sampling_rate?: number
  output_bitrate?: number
  output_audio_channels?: 'mono' | 'stereo'
  user_dictionary_uuid?: string
  leading_silence_seconds?: number
  trailing_silence_seconds?: number
  line_break_silence_seconds?: number
}

/**
 * Map xsai's OpenAI-shaped TTS request (camelCase → snake_case body) to the
 * Aivis Cloud `POST /v1/tts/synthesize` payload.
 */
export function buildSynthesizeRequest(body: OpenAITTSLikeBody): AivisCloudSynthesizeRequest {
  const voice = body.voice ?? ''
  const { speakerUuid: parsedSpeaker, styleName: parsedStyle } = parseVoiceId(voice)

  const modelUuid = body.model_uuid ?? body.model
  if (!modelUuid)
    throw new Error('Aivis Cloud: model_uuid is required (pass as provider model or providerConfig.modelUuid)')

  const speakerUuid = body.speaker_uuid ?? parsedSpeaker
  const styleName = body.style_name ?? parsedStyle
  const outputFormat = body.output_format ?? (body.response_format as AivisCloudOutputFormat | undefined)
  const speakingRate = body.speaking_rate ?? body.speed

  const payload: AivisCloudSynthesizeRequest = {
    model_uuid: modelUuid,
    text: body.input ?? '',
  }

  if (speakerUuid)
    payload.speaker_uuid = speakerUuid
  if (styleName)
    payload.style_name = styleName
  if (body.style_id != null)
    payload.style_id = body.style_id
  if (body.user_dictionary_uuid)
    payload.user_dictionary_uuid = body.user_dictionary_uuid
  if (body.use_ssml != null)
    payload.use_ssml = body.use_ssml
  if (body.use_volume_normalizer != null)
    payload.use_volume_normalizer = body.use_volume_normalizer
  if (speakingRate != null)
    payload.speaking_rate = speakingRate
  if (body.pitch != null)
    payload.pitch = body.pitch
  if (body.volume != null)
    payload.volume = body.volume
  if (body.emotional_intensity != null)
    payload.emotional_intensity = body.emotional_intensity
  if (body.tempo_dynamics != null)
    payload.tempo_dynamics = body.tempo_dynamics
  if (body.leading_silence_seconds != null)
    payload.leading_silence_seconds = body.leading_silence_seconds
  if (body.trailing_silence_seconds != null)
    payload.trailing_silence_seconds = body.trailing_silence_seconds
  if (body.line_break_silence_seconds != null)
    payload.line_break_silence_seconds = body.line_break_silence_seconds
  if (outputFormat)
    payload.output_format = outputFormat
  if (body.output_sampling_rate != null)
    payload.output_sampling_rate = body.output_sampling_rate
  if (body.output_bitrate != null)
    payload.output_bitrate = body.output_bitrate
  if (body.output_audio_channels)
    payload.output_audio_channels = body.output_audio_channels

  return payload
}

/**
 * Custom fetch adapter that translates an xsai OpenAI-compatible TTS call
 * (`POST {baseURL}/audio/speech` with body `{ model, input, voice, ...extras }`)
 * into an Aivis Cloud synthesize call with Bearer auth.
 *
 * We ignore the incoming URL — the adapter always targets
 * `{aivisBaseUrl}/v1/tts/synthesize`.
 */
export function createAivisCloudFetch(baseUrl: string, apiKey: string) {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!init?.body || typeof init.body !== 'string')
      throw new Error('Aivis Cloud fetch: invalid request body')

    const body = JSON.parse(init.body) as OpenAITTSLikeBody
    const text = body.input ?? ''
    if (text.length === 0) {
      return new Response(new Blob([], { type: 'audio/wav' }), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      })
    }

    const payload = buildSynthesizeRequest(body)

    const response = await globalThis.fetch(`${baseUrl}/v1/tts/synthesize`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': payload.output_format ? contentTypeForFormat(payload.output_format) : 'audio/mpeg',
      },
      body: JSON.stringify(payload),
      signal: init.signal ?? undefined,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`Aivis Cloud /v1/tts/synthesize failed: ${response.status} ${errorText}`)
    }

    return response
  }
}

function contentTypeForFormat(format: AivisCloudOutputFormat): string {
  switch (format) {
    case 'wav': return 'audio/wav'
    case 'flac': return 'audio/flac'
    case 'mp3': return 'audio/mpeg'
    case 'aac': return 'audio/aac'
    case 'opus': return 'audio/ogg; codecs=opus'
    default: return 'audio/mpeg'
  }
}

/**
 * Build a SpeechProvider that speaks Aivis Cloud's TTS API.
 * `model` arg of `.speech()` is the AIVM `model_uuid`. `providerConfig`
 * may override via `modelUuid` and carries all tunable extras.
 */
export function createAivisCloudSpeechProvider(
  baseUrl: string,
  apiKey: string,
): SpeechProviderWithExtraOptions<string, AivisCloudSpeechExtraOptions> {
  const normalizedBase = normalizeBaseUrl(baseUrl)
  const customFetch = createAivisCloudFetch(normalizedBase, apiKey)

  return {
    speech: (model, extraOptions) => ({
      // dummy baseURL — our fetch targets `${normalizedBase}/v1/tts/synthesize` directly.
      baseURL: `${normalizedBase}/v1/`,
      model,
      fetch: customFetch,
      ...extraOptions,
    }),
  }
}
