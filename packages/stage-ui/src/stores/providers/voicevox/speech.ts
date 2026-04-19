import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import type { VoicevoxAudioQuery, VoicevoxSpeaker, VoicevoxSpeechExtraOptions } from './types'

export const VOICEVOX_DEFAULT_BASE_URL = 'http://127.0.0.1:50021'
export const AIVISSPEECH_DEFAULT_BASE_URL = 'http://127.0.0.1:10101'

const TRAILING_SLASHES = /\/+$/

function normalizeBaseUrl(value: unknown, defaultUrl: string): string {
  let base = typeof value === 'string' ? value.trim() : ''
  if (!base)
    base = defaultUrl
  return base.replace(TRAILING_SLASHES, '')
}

/**
 * Fetch the list of available speakers (voices) from a VOICEVOX-compatible
 * engine. Each speaker has one or more styles; each style maps to a numeric
 * speaker ID used in audio_query / synthesis.
 */
export async function fetchSpeakers(baseUrl: string): Promise<VoicevoxSpeaker[]> {
  const response = await globalThis.fetch(`${baseUrl}/speakers`)
  if (!response.ok) {
    throw new Error(`VOICEVOX /speakers failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Merge user-supplied tunables into an AudioQuery. Values that are undefined
 * or not finite are dropped, preserving the engine's computed default from
 * `/audio_query`.
 */
function applyExtraOptions(query: VoicevoxAudioQuery, extras?: VoicevoxSpeechExtraOptions): VoicevoxAudioQuery {
  if (!extras)
    return query

  const merged: VoicevoxAudioQuery = { ...query }
  if (typeof extras.speedScale === 'number' && Number.isFinite(extras.speedScale))
    merged.speedScale = extras.speedScale
  if (typeof extras.pitchScale === 'number' && Number.isFinite(extras.pitchScale))
    merged.pitchScale = extras.pitchScale
  if (typeof extras.intonationScale === 'number' && Number.isFinite(extras.intonationScale))
    merged.intonationScale = extras.intonationScale
  if (typeof extras.volumeScale === 'number' && Number.isFinite(extras.volumeScale))
    merged.volumeScale = extras.volumeScale
  if (typeof extras.prePhonemeLength === 'number' && Number.isFinite(extras.prePhonemeLength))
    merged.prePhonemeLength = extras.prePhonemeLength
  if (typeof extras.postPhonemeLength === 'number' && Number.isFinite(extras.postPhonemeLength))
    merged.postPhonemeLength = extras.postPhonemeLength
  return merged
}

/**
 * Custom fetch adapter that translates an OpenAI-compatible TTS request
 * (`POST /audio/speech { model, input, voice }`) into the VOICEVOX
 * two-step synthesis pipeline:
 *   1. POST /audio_query?text=INPUT&speaker=VOICE_ID → AudioQuery JSON
 *   2. POST /synthesis?speaker=VOICE_ID (body=AudioQuery) → WAV bytes
 *
 * `extras` are captured via closure at `.speech()` call time so callers can
 * override speedScale / pitchScale / intonationScale / volumeScale without
 * relying on xsai's body-shaping behavior.
 *
 * This lets VOICEVOX/AivisSpeech ride on `@xsai/generate-speech`'s
 * `generateSpeech()` without any changes to the xsai pipeline.
 */
function createVoicevoxFetch(baseUrl: string, extras?: VoicevoxSpeechExtraOptions) {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!init?.body || typeof init.body !== 'string') {
      throw new Error('VOICEVOX fetch: invalid request body')
    }

    const body = JSON.parse(init.body) as { input?: string, voice?: string }
    const text = body.input ?? ''
    const speakerId = body.voice ?? '0'

    if (text.length === 0) {
      // Return silent WAV for empty input
      return new Response(new Blob([], { type: 'audio/wav' }), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      })
    }

    // Step 1: audio_query
    const queryUrl = `${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${encodeURIComponent(speakerId)}`
    const queryResponse = await globalThis.fetch(queryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!queryResponse.ok) {
      const errorText = await queryResponse.text()
      throw new Error(`VOICEVOX /audio_query failed: ${queryResponse.status} ${errorText}`)
    }

    const audioQuery = applyExtraOptions(await queryResponse.json() as VoicevoxAudioQuery, extras)

    // Step 2: synthesis
    const synthUrl = `${baseUrl}/synthesis?speaker=${encodeURIComponent(speakerId)}`
    const synthResponse = await globalThis.fetch(synthUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(audioQuery),
    })

    if (!synthResponse.ok) {
      const errorText = await synthResponse.text()
      throw new Error(`VOICEVOX /synthesis failed: ${synthResponse.status} ${errorText}`)
    }

    // Return the WAV audio directly
    const wavBlob = await synthResponse.blob()
    return new Response(wavBlob, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    })
  }
}

/**
 * Create a SpeechProvider compatible with Airi's provider system.
 * The `.speech(model, extraOptions)` method returns a config with a custom
 * fetch that bridges to the VOICEVOX API and applies the caller-provided
 * synthesis knobs before the /synthesis call.
 */
export function createVoicevoxSpeechProvider(baseUrl: string): SpeechProviderWithExtraOptions<string, VoicevoxSpeechExtraOptions> {
  const normalizedUrl = normalizeBaseUrl(baseUrl, VOICEVOX_DEFAULT_BASE_URL)

  return {
    speech: (model, extraOptions) => ({
      baseURL: `${normalizedUrl}/v1/`, // dummy — custom fetch ignores it
      model: model || 'voicevox',
      fetch: createVoicevoxFetch(normalizedUrl, extraOptions),
      // NOTICE: spread to satisfy `CommonRequestOptions & Partial<T2>` contract.
      // Our custom fetch only reads `body.input` and `body.voice`; other keys
      // end up serialized into the request body but are ignored downstream.
      ...extraOptions,
    }),
  }
}
