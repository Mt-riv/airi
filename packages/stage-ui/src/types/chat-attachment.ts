export interface EphemeralDocAttachment {
  id: string
  name: string
  mimeType: 'text/plain' | 'text/markdown'
  sizeBytes: number
  content: string
  tokenEstimate: number
  addedAt: number
}

export const ATTACHMENT_LIMITS = {
  perFileBytes: 128 * 1024,
  totalBytes: 512 * 1024,
  maxFiles: 8,
  allowedExtensions: ['.txt', '.md', '.markdown'] as const,
  allowedMimeTypes: ['text/plain', 'text/markdown', 'text/x-markdown', ''] as const,
} as const

export type AttachmentRejectReason
  = | 'too-large'
    | 'total-cap'
    | 'count-cap'
    | 'binary'
    | 'unsupported-extension'
    | 'duplicate'
    | 'empty'

export type AttachmentAddResult
  = | { ok: true, attachment: EphemeralDocAttachment }
    | { ok: false, reason: AttachmentRejectReason, name: string }
