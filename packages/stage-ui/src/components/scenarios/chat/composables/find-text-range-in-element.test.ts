// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { findTextRangeInElement } from './find-text-range-in-element'

function createElementFromHTML(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  return container
}

describe('findTextRangeInElement', () => {
  it('locates a segment that lives inside a single text node', () => {
    const element = createElementFromHTML('<p>Hello world, this is Airi.</p>')

    const result = findTextRangeInElement(element, 'this is Airi.')

    expect(result).not.toBeNull()
    expect(result?.range.toString()).toBe('this is Airi.')
    expect(result?.charEnd).toBe('Hello world, this is Airi.'.length)
  })

  it('locates a segment that spans multiple adjacent text nodes', () => {
    // Markdown-style emphasis splits a sentence across multiple text nodes.
    const element = createElementFromHTML('<p>Hello <strong>world</strong>, this is Airi.</p>')

    const result = findTextRangeInElement(element, 'Hello world, this is')

    expect(result).not.toBeNull()
    expect(result?.range.toString()).toBe('Hello world, this is')
  })

  it('uses fromCharOffset to skip an already-spoken occurrence of the same phrase', () => {
    const element = createElementFromHTML('<p>Airi says hi. Airi says hi again.</p>')
    const fullText = 'Airi says hi. Airi says hi again.'
    const firstOccurrence = fullText.indexOf('Airi says hi.')

    const resultAfterFirst = findTextRangeInElement(element, 'Airi says hi', firstOccurrence + 'Airi says hi'.length)

    expect(resultAfterFirst).not.toBeNull()
    // The second occurrence should start after the first one ended.
    expect(resultAfterFirst!.charEnd).toBeGreaterThan(firstOccurrence + 'Airi says hi'.length)
    expect(resultAfterFirst?.range.toString()).toBe('Airi says hi')
  })

  it('falls back to whitespace-normalized matching when the rendered DOM has extra whitespace', () => {
    // Rendered markdown often introduces newlines and indentation between tags
    // that are not present in the spoken text stream.
    const element = createElementFromHTML(`
      <p>Hello
        <strong>world</strong>,
        this is Airi.</p>
    `)

    const result = findTextRangeInElement(element, 'Hello world, this is Airi.')

    expect(result).not.toBeNull()
    expect(result?.range.toString().replace(/\s+/g, ' ').trim()).toBe('Hello world, this is Airi.')
  })

  it('returns null when no match can be found', () => {
    const element = createElementFromHTML('<p>Hello world.</p>')

    const result = findTextRangeInElement(element, 'entirely unrelated phrase')

    expect(result).toBeNull()
  })

  it('returns null for empty segment text', () => {
    const element = createElementFromHTML('<p>Hello world.</p>')

    const result = findTextRangeInElement(element, '   ')

    expect(result).toBeNull()
  })

  it('returns null when the element contains no rendered text', () => {
    const element = createElementFromHTML('<p></p>')

    const result = findTextRangeInElement(element, 'anything')

    expect(result).toBeNull()
  })
})
