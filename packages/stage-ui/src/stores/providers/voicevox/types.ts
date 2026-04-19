/** VOICEVOX / AivisSpeech REST API types. */

export interface VoicevoxSpeaker {
  name: string
  speaker_uuid: string
  styles: VoicevoxStyle[]
  version?: string
  supported_features?: {
    permitted_synthesis_morphing?: string
  }
}

export interface VoicevoxStyle {
  name: string
  id: number
  type?: string
}

/** Subset of AudioQuery — we pass through the full JSON blob. */
export interface VoicevoxAudioQuery {
  accent_phrases: unknown[]
  speedScale: number
  pitchScale: number
  intonationScale: number
  volumeScale: number
  prePhonemeLength: number
  postPhonemeLength: number
  outputSamplingRate: number
  outputStereo: boolean
  [key: string]: unknown
}

/**
 * Synthesis-time knobs for VOICEVOX / AivisSpeech. Field names match the
 * AudioQuery JSON (speedScale / pitchScale / ...) so the fetch adapter can
 * merge them verbatim before POST /synthesis.
 *
 * All fields are optional — undefined means "keep the engine default from
 * the /audio_query response".
 */
export interface VoicevoxSpeechExtraOptions {
  speedScale?: number
  pitchScale?: number
  intonationScale?: number
  volumeScale?: number
  prePhonemeLength?: number
  postPhonemeLength?: number
}
