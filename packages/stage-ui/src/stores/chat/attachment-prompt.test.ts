import type { EphemeralDocAttachment } from '../../types/chat-attachment'

import { describe, expect, it } from 'vitest'

import { buildAttachmentPromptMessage, formatAttachmentPromptText } from './attachment-prompt'

function makeItem(overrides: Partial<EphemeralDocAttachment> = {}): EphemeralDocAttachment {
  return {
    id: 'id-1',
    name: 'notes.md',
    mimeType: 'text/markdown',
    sizeBytes: 12,
    content: 'Hello AIRI',
    tokenEstimate: 4,
    addedAt: 0,
    ...overrides,
  }
}

describe('buildAttachmentPromptMessage', () => {
  it('returns null for empty input', () => {
    expect(buildAttachmentPromptMessage([])).toBeNull()
    expect(formatAttachmentPromptText([])).toBe('')
  })

  it('wraps single document in XML block with count=1', () => {
    const msg = buildAttachmentPromptMessage([makeItem()])
    expect(msg).not.toBeNull()
    expect(msg!.role).toBe('user')
    const text = (msg!.content as Array<{ type: string, text: string }>)[0].text
    expect(text).toContain('<attached_documents count="1">')
    expect(text).toContain('<document name="notes.md" mime="text/markdown" size="12">')
    expect(text).toContain('Hello AIRI')
    expect(text).toContain('</attached_documents>')
  })

  it('concatenates multiple documents and reflects count', () => {
    const msg = buildAttachmentPromptMessage([
      makeItem({ id: 'a', name: 'a.md', content: 'AAA' }),
      makeItem({ id: 'b', name: 'b.txt', mimeType: 'text/plain', content: 'BBB' }),
    ])
    const text = (msg!.content as Array<{ type: string, text: string }>)[0].text
    expect(text).toContain('<attached_documents count="2">')
    expect(text).toContain('name="a.md"')
    expect(text).toContain('name="b.txt"')
    expect(text).toContain('AAA')
    expect(text).toContain('BBB')
  })

  it('escapes XML-special characters in filenames', () => {
    const msg = buildAttachmentPromptMessage([
      makeItem({ name: 'a&b<c>"d\'.md' }),
    ])
    const text = (msg!.content as Array<{ type: string, text: string }>)[0].text
    expect(text).toContain('name="a&amp;b&lt;c&gt;&quot;d&apos;.md"')
  })
})
