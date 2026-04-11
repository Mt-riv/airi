import type { SpeechProvider } from '@xsai-ext/providers/utils'

import type { VoicevoxAudioQuery, VoicevoxSpeaker } from './types'

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
 * Custom fetch adapter that translates an OpenAI-compatible TTS request
 * (`POST /audio/speech { model, input, voice }`) into the VOICEVOX
 * two-step synthesis pipeline:
 *   1. POST /audio_query?text=INPUT&speaker=VOICE_ID → AudioQuery JSON
 *   2. POST /synthesis?speaker=VOICE_ID (body=AudioQuery) → WAV bytes
 *
 * This lets VOICEVOX/AivisSpeech ride on `@xsai/generate-speech`'s
 * `generateSpeech()` without any changes to the xsai pipeline.
 */
function createVoicevoxFetch(baseUrl: string) {
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

    const audioQuery: VoicevoxAudioQuery = await queryResponse.json()

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
 * The `.speech(model)` method returns a config with a custom fetch
 * that bridges to the VOICEVOX API.
 */
export function createVoicevoxSpeechProvider(baseUrl: string): SpeechProvider {
  const normalizedUrl = normalizeBaseUrl(baseUrl, VOICEVOX_DEFAULT_BASE_URL)

  return {
    speech: () => ({
      baseURL: `${normalizedUrl}/v1/`, // dummy — custom fetch ignores it
      model: 'voicevox',
      fetch: createVoicevoxFetch(normalizedUrl),
    }),
  }
}
