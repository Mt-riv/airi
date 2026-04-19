/** Aivis Cloud API types — subset used by Airi. */

export const AIVIS_CLOUD_DEFAULT_BASE_URL = 'https://api.aivis-project.com'
export const AIVIS_CLOUD_DEFAULT_MODEL_UUID = 'a59cb814-0083-4369-8542-f51a29e72af7'

/**
 * Sentinel voice id for "use whatever default the AIVM model exposes".
 * `parseVoiceId` + `buildSynthesizeRequest` recognize this and omit
 * both `speaker_uuid` and `style_name` from the synthesize payload.
 */
export const AIVIS_CLOUD_DEFAULT_VOICE_ID = '__aivis_cloud_default__'

export type AivisCloudOutputFormat = 'wav' | 'flac' | 'mp3' | 'aac' | 'opus'

/**
 * Request body for `POST /v1/tts/synthesize`.
 * https://api.aivis-project.com/v1/docs#tag/Text-to-Speech
 */
export interface AivisCloudSynthesizeRequest {
  model_uuid: string
  speaker_uuid?: string
  style_id?: number
  style_name?: string
  user_dictionary_uuid?: string
  text: string
  use_ssml?: boolean
  use_volume_normalizer?: boolean
  speaking_rate?: number
  pitch?: number
  volume?: number
  emotional_intensity?: number
  tempo_dynamics?: number
  leading_silence_seconds?: number
  trailing_silence_seconds?: number
  line_break_silence_seconds?: number
  output_format?: AivisCloudOutputFormat
  output_sampling_rate?: number
  output_bitrate?: number
  output_audio_channels?: 'mono' | 'stereo'
  language?: 'ja'
}

/** Per-style entry under a speaker. */
export interface AivmModelStyle {
  id: number
  name: string
  local_id?: number
}

/** Speaker entry inside an AIVM model. */
export interface AivmModelSpeaker {
  aivm_speaker_uuid: string
  name: string
  styles: AivmModelStyle[]
  version?: string
  icon_url?: string
}

/**
 * Response from `GET /v1/aivm-models/{uuid}`.
 * Only fields we consume are modelled; the API returns more metadata.
 */
export interface AivmModel {
  aivm_model_uuid: string
  name: string
  speakers: AivmModelSpeaker[]
  description?: string
}
