import type { AttachmentAddResult, EphemeralDocAttachment } from '../../types/chat-attachment'

import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import {
  ATTACHMENT_LIMITS,

} from '../../types/chat-attachment'

function extensionOf(name: string): string {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? lower.slice(dot) : ''
}

function inferMimeType(name: string): 'text/plain' | 'text/markdown' {
  const ext = extensionOf(name)
  if (ext === '.md' || ext === '.markdown')
    return 'text/markdown'
  return 'text/plain'
}

async function decodeUtf8Strict(file: File): Promise<string | null> {
  try {
    const buffer = await file.arrayBuffer()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return decoder.decode(buffer)
  }
  catch {
    return null
  }
}

function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4))
}

export const useChatAttachmentStore = defineStore('chat-ephemeral-attachments', () => {
  const items = ref<EphemeralDocAttachment[]>([])

  const totalBytes = computed(() =>
    items.value.reduce((sum, item) => sum + item.sizeBytes, 0),
  )

  const totalTokenEstimate = computed(() =>
    items.value.reduce((sum, item) => sum + item.tokenEstimate, 0),
  )

  async function addFromFile(file: File): Promise<AttachmentAddResult> {
    const name = file.name || 'untitled'

    const ext = extensionOf(name)
    if (!ATTACHMENT_LIMITS.allowedExtensions.includes(ext as never)) {
      return { ok: false, reason: 'unsupported-extension', name }
    }

    if (file.size === 0) {
      return { ok: false, reason: 'empty', name }
    }

    if (file.size > ATTACHMENT_LIMITS.perFileBytes) {
      return { ok: false, reason: 'too-large', name }
    }

    if (items.value.length >= ATTACHMENT_LIMITS.maxFiles) {
      return { ok: false, reason: 'count-cap', name }
    }

    if (totalBytes.value + file.size > ATTACHMENT_LIMITS.totalBytes) {
      return { ok: false, reason: 'total-cap', name }
    }

    if (items.value.some(item => item.name === name && item.sizeBytes === file.size)) {
      return { ok: false, reason: 'duplicate', name }
    }

    const content = await decodeUtf8Strict(file)
    if (content === null) {
      return { ok: false, reason: 'binary', name }
    }

    const attachment: EphemeralDocAttachment = {
      id: nanoid(),
      name,
      mimeType: inferMimeType(name),
      sizeBytes: file.size,
      content,
      tokenEstimate: estimateTokens(content),
      addedAt: Date.now(),
    }

    items.value.push(attachment)
    return { ok: true, attachment }
  }

  function remove(id: string): boolean {
    const index = items.value.findIndex(item => item.id === id)
    if (index < 0)
      return false
    items.value.splice(index, 1)
    return true
  }

  function clear() {
    items.value = []
  }

  return {
    items,
    totalBytes,
    totalTokenEstimate,
    addFromFile,
    remove,
    clear,
  }
})
