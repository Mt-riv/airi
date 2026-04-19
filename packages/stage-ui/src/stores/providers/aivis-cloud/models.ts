import type { AivmModel } from './types'

import { AIVIS_CLOUD_DEFAULT_BASE_URL } from './types'

const TRAILING_SLASHES = /\/+$/

function normalize(baseUrl: string): string {
  return (baseUrl || AIVIS_CLOUD_DEFAULT_BASE_URL).replace(TRAILING_SLASHES, '')
}

/**
 * Retrieve an AIVM model's speakers/styles from `GET /v1/aivm-models/{uuid}`.
 * Authentication is optional for public models but we always send the key
 * when configured, matching Aivis Cloud's recommendation.
 */
export async function fetchAivmModel(
  baseUrl: string,
  apiKey: string | undefined,
  modelUuid: string,
  signal?: AbortSignal,
): Promise<AivmModel> {
  const url = `${normalize(baseUrl)}/v1/aivm-models/${encodeURIComponent(modelUuid)}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey)
    headers.Authorization = `Bearer ${apiKey}`

  const response = await globalThis.fetch(url, { headers, signal })
  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`Aivis Cloud /v1/aivm-models/${modelUuid} failed: ${response.status} ${errorText}`)
  }

  return response.json() as Promise<AivmModel>
}

/**
 * Probe `GET /v1/users/me` to verify the API key is valid.
 * Returns `{ ok: true }` on success, else `{ ok: false, status, message }`.
 */
export async function pingAivisCloud(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false, status: number, message: string }> {
  const url = `${normalize(baseUrl)}/v1/users/me`
  const response = await globalThis.fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal,
  })

  if (response.ok)
    return { ok: true }

  const text = await response.text().catch(() => '')
  return { ok: false, status: response.status, message: text || response.statusText }
}
