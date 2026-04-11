import { describe, expect, it } from 'vitest'

import { cleanTextForSpeech, splitIntoSentences } from './text-filter'

describe('cleanTextForSpeech', () => {
  it('should return empty string for empty input', () => {
    expect(cleanTextForSpeech('')).toBe('')
  })

  it('should return already clean text unchanged', () => {
    expect(cleanTextForSpeech('Hello, this is a normal sentence.')).toBe(
      'Hello, this is a normal sentence.',
    )
  })

  it('should remove fenced code blocks with language tags', () => {
    const input = `Here is some code:

\`\`\`typescript
function hello() {
  console.log("hello")
}
\`\`\`

That was the code.`

    const result = cleanTextForSpeech(input)
    expect(result).not.toContain('```')
    expect(result).not.toContain('console.log')
    expect(result).toContain('Here is some code:')
    expect(result).toContain('That was the code.')
  })

  it('should remove fenced code blocks without language tags', () => {
    const input = `Example:

\`\`\`
some code here
\`\`\`

Done.`

    const result = cleanTextForSpeech(input)
    expect(result).not.toContain('```')
    expect(result).not.toContain('some code here')
    expect(result).toContain('Example:')
    expect(result).toContain('Done.')
  })

  it('should preserve inline code text content without backticks', () => {
    const input = 'Use the `forEach` method to iterate.'
    const result = cleanTextForSpeech(input)
    expect(result).toBe('Use the forEach method to iterate.')
  })

  it('should remove XML/HTML tags but keep content', () => {
    expect(cleanTextForSpeech('<b>bold text</b>')).toBe('bold text')
    expect(cleanTextForSpeech('<self-closing />')).toBe('')
    expect(cleanTextForSpeech('<thinking>internal</thinking>')).toBe('internal')
  })

  it('should remove markdown headings but keep text', () => {
    expect(cleanTextForSpeech('# Main Heading')).toBe('Main Heading')
    expect(cleanTextForSpeech('## Sub Heading')).toBe('Sub Heading')
    expect(cleanTextForSpeech('### Third Level')).toBe('Third Level')
  })

  it('should remove horizontal rules', () => {
    expect(cleanTextForSpeech('---')).toBe('')
    expect(cleanTextForSpeech('***')).toBe('')
    expect(cleanTextForSpeech('___')).toBe('')
    expect(cleanTextForSpeech('------')).toBe('')
  })

  it('should remove table syntax', () => {
    const input = `Here is a table:
| Header 1 | Header 2 |
| --- | --- |
| Cell 1 | Cell 2 |

After the table.`

    const result = cleanTextForSpeech(input)
    expect(result).not.toContain('|')
    expect(result).toContain('Here is a table:')
    expect(result).toContain('After the table.')
  })

  it('should remove blockquote markers but keep text', () => {
    expect(cleanTextForSpeech('> This is quoted text')).toBe('This is quoted text')
    expect(cleanTextForSpeech('> > Nested quote')).toBe('Nested quote')
  })

  it('should remove list markers but keep text', () => {
    expect(cleanTextForSpeech('- Item one')).toBe('Item one')
    expect(cleanTextForSpeech('* Item two')).toBe('Item two')
    expect(cleanTextForSpeech('1. Item three')).toBe('Item three')
    expect(cleanTextForSpeech('12. Item twelve')).toBe('Item twelve')
  })

  it('should remove URLs', () => {
    expect(cleanTextForSpeech('Visit http://example.com for info')).toBe('Visit for info')
    expect(cleanTextForSpeech('See https://example.com/path?q=1 here')).toBe('See here')
  })

  it('should remove git hashes', () => {
    expect(cleanTextForSpeech('Commit 17fb636d fixed the bug')).toBe('Commit fixed the bug')
    expect(cleanTextForSpeech('Hash abc1234 is short')).toBe('Hash is short')
    expect(cleanTextForSpeech('Full hash abcdef1234567890abcdef1234567890abcdef12')).toBe('Full hash')
  })

  it('should not remove short hex-like words that are not git hashes', () => {
    // Words shorter than 7 hex chars should be kept
    expect(cleanTextForSpeech('Use abc as name')).toBe('Use abc as name')
  })

  it('should convert image markdown to alt text', () => {
    expect(cleanTextForSpeech('![screenshot](http://img.png)')).toBe('screenshot')
  })

  it('should convert link markdown to text', () => {
    expect(cleanTextForSpeech('[click here](http://example.com)')).toBe('click here')
  })

  it('should collapse multiple newlines into single space', () => {
    const input = 'First paragraph.\n\n\n\nSecond paragraph.'
    const result = cleanTextForSpeech(input)
    expect(result).toBe('First paragraph. Second paragraph.')
  })

  it('should collapse multiple spaces into single space', () => {
    expect(cleanTextForSpeech('Too   many    spaces')).toBe('Too many spaces')
  })

  it('should trim leading and trailing whitespace', () => {
    expect(cleanTextForSpeech('  hello world  ')).toBe('hello world')
  })

  it('should handle mixed markdown content', () => {
    const input = `# Summary

Here is the plan:

> Important note

- First step
- Second step
* Third step

1. Do this
2. Do that

### Details

Some **bold** and *italic* text.`

    const result = cleanTextForSpeech(input)
    expect(result).toContain('Summary')
    expect(result).toContain('Here is the plan:')
    expect(result).toContain('Important note')
    expect(result).toContain('First step')
    expect(result).toContain('Second step')
    expect(result).toContain('Third step')
    expect(result).toContain('Do this')
    expect(result).toContain('Do that')
    expect(result).toContain('Details')
    expect(result).not.toContain('#')
    expect(result).not.toContain('>')
    expect(result).not.toMatch(/^[-*]/m)
    expect(result).not.toMatch(/^\d+\./m)
  })

  it('should handle a real-world Claude Code response', () => {
    const input = `I'll help you fix that bug. Let me look at the code:

\`\`\`typescript
export function calculate(a: number, b: number): number {
  return a + b
}
\`\`\`

The issue is in the \`calculate\` function. Here's what I changed:

1. Fixed the return type
2. Added input validation

You can test it by running:

\`\`\`bash
npm test
\`\`\`

See https://docs.example.com/api for more details.

The commit 17fb636d should have the fix. Let me know if you need anything else!`

    const result = cleanTextForSpeech(input)

    // Should keep natural language
    expect(result).toContain('help you fix that bug')
    expect(result).toContain('The issue is in the calculate function')
    expect(result).toContain('Fixed the return type')
    expect(result).toContain('Added input validation')
    expect(result).toContain('Let me know if you need anything else!')

    // Should remove code, URLs, hashes
    expect(result).not.toContain('```')
    expect(result).not.toContain('export function')
    expect(result).not.toContain('npm test')
    expect(result).not.toContain('https://')
    expect(result).not.toContain('17fb636d')
  })
})

describe('splitIntoSentences', () => {
  it('should return empty array for empty input', () => {
    expect(splitIntoSentences('')).toEqual([])
  })

  it('should split Japanese text on sentence terminators', () => {
    const input = 'これは文です。次の文です！質問ですか？'
    const result = splitIntoSentences(input)
    expect(result).toEqual([
      'これは文です。',
      '次の文です！',
      '質問ですか？',
    ])
  })

  it('should split English text on period-space', () => {
    const input = 'First sentence. Second sentence. Third sentence.'
    const result = splitIntoSentences(input)
    expect(result).toEqual([
      'First sentence.',
      'Second sentence.',
      'Third sentence.',
    ])
  })

  it('should split on exclamation and question marks', () => {
    const input = 'Wow! Is that real? Yes it is.'
    const result = splitIntoSentences(input)
    expect(result).toEqual([
      'Wow!',
      'Is that real?',
      'Yes it is.',
    ])
  })

  it('should split on newlines', () => {
    const input = 'Line one\nLine two\nLine three'
    const result = splitIntoSentences(input)
    expect(result).toEqual([
      'Line one',
      'Line two',
      'Line three',
    ])
  })

  it('should not split on dots inside version numbers', () => {
    const input = 'Updated to v2.1.96 successfully.'
    const result = splitIntoSentences(input)
    expect(result).toEqual(['Updated to v2.1.96 successfully.'])
  })

  it('should not split on dots inside abbreviations or numbers', () => {
    const input = 'Use e.g. this pattern. It works well.'
    const result = splitIntoSentences(input)
    // "e.g." should not cause a split mid-abbreviation
    expect(result.length).toBe(2)
    expect(result[0]).toContain('e.g.')
  })

  it('should filter out empty strings', () => {
    const input = 'Hello!\n\n\nWorld!'
    const result = splitIntoSentences(input)
    expect(result).toEqual(['Hello!', 'World!'])
  })

  it('should trim each sentence', () => {
    const input = '  Hello world.   Goodbye world.  '
    const result = splitIntoSentences(input)
    expect(result).toEqual(['Hello world.', 'Goodbye world.'])
  })

  it('should handle mixed Japanese and English', () => {
    const input = 'Hello! これはテストです。It works well.'
    const result = splitIntoSentences(input)
    expect(result).toEqual([
      'Hello!',
      'これはテストです。',
      'It works well.',
    ])
  })
})
