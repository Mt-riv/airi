import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildSynthesizeRequest,
  createAivisCloudFetch,
  createAivisCloudSpeechProvider,
  normalizeBaseUrl,
  parseVoiceId,
} from './speech'
import { AIVIS_CLOUD_DEFAULT_VOICE_ID } from './types'

describe('parseVoiceId', () => {
  it('splits speakerUuid:styleName', () => {
    expect(parseVoiceId('11111111-2222-3333-4444-555555555555:Normal'))
      .toEqual({ speakerUuid: '11111111-2222-3333-4444-555555555555', styleName: 'Normal' })
  })

  it('treats a bare UUID as speakerUuid only', () => {
    expect(parseVoiceId('11111111-2222-3333-4444-555555555555'))
      .toEqual({ speakerUuid: '11111111-2222-3333-4444-555555555555' })
  })

  it('treats a bare string as styleName only', () => {
    expect(parseVoiceId('Happy')).toEqual({ styleName: 'Happy' })
  })

  it('returns empty object for empty input', () => {
    expect(parseVoiceId('')).toEqual({})
    expect(parseVoiceId('   ')).toEqual({})
  })

  it('treats the default-voice sentinel as empty (no speaker/style override)', () => {
    expect(parseVoiceId(AIVIS_CLOUD_DEFAULT_VOICE_ID)).toEqual({})
  })
})

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.aivis-project.com/')).toBe('https://api.aivis-project.com')
    expect(normalizeBaseUrl('https://api.aivis-project.com///')).toBe('https://api.aivis-project.com')
  })

  it('falls back to default on empty / non-string', () => {
    expect(normalizeBaseUrl('')).toBe('https://api.aivis-project.com')
    expect(normalizeBaseUrl(undefined)).toBe('https://api.aivis-project.com')
    expect(normalizeBaseUrl(42)).toBe('https://api.aivis-project.com')
  })
})

describe('buildSynthesizeRequest', () => {
  it('maps OpenAI body to Aivis Cloud payload and parses voice id', () => {
    const req = buildSynthesizeRequest({
      model: 'model-xxx',
      input: 'こんにちは',
      voice: 'speaker-uuid-1:Happy',
      speed: 1.2,
      pitch: 0.1,
      volume: 1.3,
      emotional_intensity: 1.5,
      output_format: 'wav',
    })

    expect(req).toEqual({
      model_uuid: 'model-xxx',
      text: 'こんにちは',
      speaker_uuid: 'speaker-uuid-1',
      style_name: 'Happy',
      speaking_rate: 1.2,
      pitch: 0.1,
      volume: 1.3,
      emotional_intensity: 1.5,
      output_format: 'wav',
    })
  })

  it('prefers explicit model_uuid over model', () => {
    const req = buildSynthesizeRequest({
      model: 'from-model-field',
      model_uuid: 'explicit-model-uuid',
      input: 'x',
      voice: '',
    })
    expect(req.model_uuid).toBe('explicit-model-uuid')
  })

  it('throws when model_uuid is missing', () => {
    expect(() => buildSynthesizeRequest({ input: 'hi', voice: 'Happy' }))
      .toThrow(/model_uuid is required/)
  })
})

describe('createAivisCloudFetch', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('sends POST to /v1/tts/synthesize with Bearer auth and mapped body', async () => {
    const audioBuffer = new Uint8Array([1, 2, 3, 4]).buffer
    ;(globalThis.fetch as any).mockResolvedValueOnce(new Response(audioBuffer, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    }))

    const fetchFn = createAivisCloudFetch('https://api.aivis-project.com', 'secret-key')
    const response = await fetchFn('https://ignored.example/audio/speech', {
      method: 'POST',
      body: JSON.stringify({
        model: 'model-uuid-42',
        input: 'テスト',
        voice: 'speaker-uuid-1:Normal',
        speaking_rate: 1.1,
      }),
    })

    expect(response.ok).toBe(true)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (globalThis.fetch as any).mock.calls[0]
    expect(url).toBe('https://api.aivis-project.com/v1/tts/synthesize')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer secret-key')
    expect(init.headers['Content-Type']).toBe('application/json')
    const payload = JSON.parse(init.body as string)
    expect(payload).toMatchObject({
      model_uuid: 'model-uuid-42',
      text: 'テスト',
      speaker_uuid: 'speaker-uuid-1',
      style_name: 'Normal',
      speaking_rate: 1.1,
    })
  })

  it('short-circuits empty input to silent WAV without calling network', async () => {
    const fetchFn = createAivisCloudFetch('https://api.aivis-project.com', 'secret-key')
    const response = await fetchFn('ignored', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: '', voice: 'Normal' }),
    })

    expect(response.ok).toBe(true)
    expect(response.headers.get('Content-Type')).toBe('audio/wav')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('throws with status when upstream returns non-OK', async () => {
    ;(globalThis.fetch as any).mockResolvedValueOnce(new Response('Invalid API key', {
      status: 401,
      statusText: 'Unauthorized',
    }))

    const fetchFn = createAivisCloudFetch('https://api.aivis-project.com', 'bad-key')
    await expect(
      fetchFn('ignored', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', input: 'hi', voice: 'Normal' }),
      }),
    ).rejects.toThrow(/401 Invalid API key/)
  })
})

describe('createAivisCloudSpeechProvider', () => {
  it('returns SpeechProvider with custom fetch and carries extra options', () => {
    const provider = createAivisCloudSpeechProvider('https://api.aivis-project.com/', 'k')
    const options = provider.speech('model-uuid', { speed: 1.5, emotionalIntensity: 1.2 } as any)

    expect(options.model).toBe('model-uuid')
    expect(options.baseURL).toBe('https://api.aivis-project.com/v1/')
    expect(typeof options.fetch).toBe('function')
    expect((options as any).speed).toBe(1.5)
    expect((options as any).emotionalIntensity).toBe(1.2)
  })
})
