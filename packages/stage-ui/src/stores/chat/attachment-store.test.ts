import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { ATTACHMENT_LIMITS } from '../../types/chat-attachment'
import { useChatAttachmentStore } from './attachment-store'

function makeTextFile(name: string, content: string, type = 'text/plain'): File {
  return new File([content], name, { type })
}

function makeBinaryFile(name: string, byteValues: number[]): File {
  const bytes = new Uint8Array(byteValues)
  return new File([bytes], name, { type: 'application/octet-stream' })
}

describe('useChatAttachmentStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('adds a valid .md file and exposes it via items', async () => {
    const store = useChatAttachmentStore()
    const result = await store.addFromFile(makeTextFile('notes.md', '# Title\nHello world', 'text/markdown'))

    expect(result.ok).toBe(true)
    expect(store.items).toHaveLength(1)
    expect(store.items[0].name).toBe('notes.md')
    expect(store.items[0].mimeType).toBe('text/markdown')
    expect(store.items[0].content).toContain('Hello world')
    expect(store.items[0].tokenEstimate).toBeGreaterThan(0)
    expect(store.totalBytes).toBe(store.items[0].sizeBytes)
  })

  it('rejects unsupported extensions', async () => {
    const store = useChatAttachmentStore()
    const result = await store.addFromFile(makeTextFile('image.png', 'not really a png'))

    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('unsupported-extension')
    expect(store.items).toHaveLength(0)
  })

  it('rejects empty files', async () => {
    const store = useChatAttachmentStore()
    const result = await store.addFromFile(makeTextFile('empty.txt', ''))

    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('empty')
  })

  it('rejects files exceeding the per-file size cap', async () => {
    const store = useChatAttachmentStore()
    const content = 'x'.repeat(ATTACHMENT_LIMITS.perFileBytes + 1)
    const result = await store.addFromFile(makeTextFile('big.txt', content))

    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('too-large')
  })

  it('rejects non-UTF-8 binary content even with an allowed extension', async () => {
    const store = useChatAttachmentStore()
    // 0xFF is not valid as the first byte of a UTF-8 sequence.
    const result = await store.addFromFile(makeBinaryFile('binary.txt', [0xFF, 0xFE, 0xFD]))

    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.reason).toBe('binary')
  })

  it('rejects duplicates by name+size', async () => {
    const store = useChatAttachmentStore()
    await store.addFromFile(makeTextFile('notes.md', 'Hello'))
    const second = await store.addFromFile(makeTextFile('notes.md', 'Hello'))

    expect(second.ok).toBe(false)
    if (!second.ok)
      expect(second.reason).toBe('duplicate')
    expect(store.items).toHaveLength(1)
  })

  it('enforces the maxFiles count cap', async () => {
    const store = useChatAttachmentStore()
    for (let i = 0; i < ATTACHMENT_LIMITS.maxFiles; i++) {
      const ok = await store.addFromFile(makeTextFile(`doc-${i}.txt`, `content ${i}`))
      expect(ok.ok).toBe(true)
    }
    const overflow = await store.addFromFile(makeTextFile('extra.txt', 'nope'))
    expect(overflow.ok).toBe(false)
    if (!overflow.ok)
      expect(overflow.reason).toBe('count-cap')
  })

  it('enforces the total-size cap across multiple files', async () => {
    const store = useChatAttachmentStore()
    const chunk = 'y'.repeat(ATTACHMENT_LIMITS.perFileBytes)
    // perFile is 128 KB, totalBytes is 512 KB => five 128KB files would exceed 512KB.
    const fillCount = Math.floor(ATTACHMENT_LIMITS.totalBytes / ATTACHMENT_LIMITS.perFileBytes)
    for (let i = 0; i < fillCount; i++) {
      const ok = await store.addFromFile(makeTextFile(`fill-${i}.txt`, chunk))
      expect(ok.ok).toBe(true)
    }
    const overflow = await store.addFromFile(makeTextFile('overflow.txt', chunk))
    expect(overflow.ok).toBe(false)
    if (!overflow.ok)
      expect(overflow.reason).toBe('total-cap')
  })

  it('removes by id', async () => {
    const store = useChatAttachmentStore()
    const added = await store.addFromFile(makeTextFile('a.md', 'A'))
    expect(added.ok).toBe(true)
    if (!added.ok)
      return
    expect(store.remove(added.attachment.id)).toBe(true)
    expect(store.items).toHaveLength(0)
  })

  it('clears all entries', async () => {
    const store = useChatAttachmentStore()
    await store.addFromFile(makeTextFile('a.md', 'A'))
    await store.addFromFile(makeTextFile('b.md', 'B'))
    expect(store.items).toHaveLength(2)
    store.clear()
    expect(store.items).toHaveLength(0)
    expect(store.totalBytes).toBe(0)
  })
})
