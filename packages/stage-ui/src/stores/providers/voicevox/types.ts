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
