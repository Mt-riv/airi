import { describe, expect, it } from 'vitest'

import { useLlmmarkerParser } from './llm-marker-parser'

describe('useLlmmarkerParser', async () => {
  it('should parse pure literals', async () => {
    const fullText = 'Hello, world!'
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []

    const parser = useLlmmarkerParser({
      onLiteral(literal) {
        collectedLiterals.push(literal)
      },
      onSpecial(special) {
        collectedSpecials.push(special)
      },
    })

    for (const char of fullText) {
      await parser.consume(char)
    }

    await parser.end()

    expect(collectedLiterals.join('')).toBe('Hello, world!')
    expect(collectedSpecials).toEqual([])
  })

  it('should parse pure specials', async () => {
    const fullText = '<|Hello, world!|>'
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []

    const parser = useLlmmarkerParser({
      onLiteral(literal) {
        collectedLiterals.push(literal)
      },
      onSpecial(special) {
        collectedSpecials.push(special)
      },
    })

    for (const char of fullText) {
      await parser.consume(char)
    }

    await parser.end()

    expect(collectedLiterals).toEqual([])
    expect(collectedSpecials).toEqual(['<|Hello, world!|>'])
  })

  it('should parse escaped specials', async () => {
    const fullText = '<{\'|\'}Hello, world!{\'|\'}>'
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []

    const parser = useLlmmarkerParser({
      onLiteral(literal) {
        collectedLiterals.push(literal)
      },
      onSpecial(special) {
        collectedSpecials.push(special)
      },
    })

    for (const char of fullText) {
      await parser.consume(char)
    }

    await parser.end()

    expect(collectedLiterals).toEqual([])
    expect(collectedSpecials).toEqual(['<|Hello, world!|>'])
  })

  it('should not include unfinished special', async () => {
    const fullText = '<|Hello, world'
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []

    const parser = useLlmmarkerParser({
      onLiteral(literal) {
        collectedLiterals.push(literal)
      },
      onSpecial(special) {
        collectedSpecials.push(special)
      },
    })

    for (const char of fullText) {
      await parser.consume(char)
    }

    await parser.end()

    expect(collectedLiterals).toEqual([])
    expect(collectedSpecials).toEqual([])
  })

  it('should not include unfinished escaped special', async () => {
    const fullText = '<{\'|\'}Hello, world'
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []

    const parser = useLlmmarkerParser({
      onLiteral(literal) {
        collectedLiterals.push(literal)
      },
      onSpecial(special) {
        collectedSpecials.push(special)
      },
    })

    for (const char of fullText) {
      await parser.consume(char)
    }

    await parser.end()

    expect(collectedLiterals).toEqual([])
    expect(collectedSpecials).toEqual([])
  })

  it('should parse with mixed input, ends with special', async () => {
    const fullText = 'This is sentence 1, <|HELLO|> and this is sentence 2.<|WORLD|>'
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []

    const parser = useLlmmarkerParser({
      onLiteral(literal) {
        collectedLiterals.push(literal)
      },
      onSpecial(special) {
        collectedSpecials.push(special)
      },
    })

    for (const char of fullText) {
      await parser.consume(char)
    }

    await parser.end()

    expect(collectedLiterals.join('')).toBe('This is sentence 1,  and this is sentence 2.')
    expect(collectedSpecials).toEqual(['<|HELLO|>', '<|WORLD|>'])
  })

  it('should parse with mixed input, ends with escaped special', async () => {
    const fullText = 'This is sentence 1, <{\'|\'}HELLO{\'|\'}> and this is sentence 2.<{\'|\'}WORLD{\'|\'}>'
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []

    const parser = useLlmmarkerParser({
      onLiteral(literal) {
        collectedLiterals.push(literal)
      },
      onSpecial(special) {
        collectedSpecials.push(special)
      },
    })

    for (const char of fullText) {
      await parser.consume(char)
    }

    await parser.end()

    expect(collectedLiterals.join('')).toBe('This is sentence 1,  and this is sentence 2.')
    expect(collectedSpecials).toEqual(['<|HELLO|>', '<|WORLD|>'])
  })

  it('should parse correctly', async () => {
    const testCases: { input: string, expectedLiterals: string, expectedSpecials: string[] }[] = [
      {
        input: `<|A|> Wow, hello there!`,
        expectedLiterals: ' Wow, hello there!',
        expectedSpecials: ['<|A|>'],
      },
      {
        input: `<|A|> Hello!`,
        expectedLiterals: ' Hello!',
        expectedSpecials: ['<|A|>'],
      },
      {
        input: `<|A|> Hello! <|B|>`,
        expectedLiterals: ' Hello! ',
        expectedSpecials: ['<|A|>', '<|B|>'],
      },
      {
        input: '<{\'|\'}A{\'|\'}> Wow, hello there!',
        expectedLiterals: ' Wow, hello there!',
        expectedSpecials: ['<|A|>'],
      },
      {
        input: '<{\'|\'}A{\'|\'}> Hello!',
        expectedLiterals: ' Hello!',
        expectedSpecials: ['<|A|>'],
      },
      {
        input: '<{\'|\'}A{\'|\'}> Hello! <{\'|\'}B{\'|\'}>',
        expectedLiterals: ' Hello! ',
        expectedSpecials: ['<|A|>', '<|B|>'],
      },
    ]

    for (const tc of testCases) {
      const { input, expectedLiterals, expectedSpecials } = tc
      const collectedLiterals: string[] = []
      const collectedSpecials: string[] = []

      const parser = useLlmmarkerParser({
        onLiteral(literal) {
          collectedLiterals.push(literal)
        },
        onSpecial(special) {
          collectedSpecials.push(special)
        },
      })

      for (const char of input) {
        await parser.consume(char)
      }

      await parser.end()

      expect(collectedLiterals.join('')).toBe(expectedLiterals)
      expect(collectedSpecials).toEqual(expectedSpecials)
    }
  })

  it('should call onEnd with full text', async () => {
    const fullText = 'Hello, world!'
    let endText = ''

    const parser = useLlmmarkerParser({
      onEnd(text) {
        endText = text
      },
    })

    for (const char of fullText) {
      await parser.consume(char)
    }

    await parser.end()

    expect(endText).toBe(fullText)
  })

  it('should call onEnd with full text including specials', async () => {
    const fullText = 'Hello <|special|> world!'
    let endText = ''

    const parser = useLlmmarkerParser({
      onEnd(text) {
        endText = text
      },
    })

    for (const char of fullText) {
      await parser.consume(char)
    }

    await parser.end()

    expect(endText).toBe(fullText)
  })

  it('should call onEnd with full text including escaped specials', async () => {
    const fullText = 'Hello <{\'|\'}special{\'|\'}> world!'
    let endText = ''

    const parser = useLlmmarkerParser({
      onEnd(text) {
        endText = text
      },
    })

    for (const char of fullText) {
      await parser.consume(char)
    }

    await parser.end()

    expect(endText).toBe(fullText)
  })

  // Regression: emoji on the astral plane (🤔 = U+1F914) is encoded as a
  // surrogate pair in UTF-16. The parser used to emit literals with
  // `buffer.slice(0, -tailLength)`, which could land mid-pair and hand a lone
  // high surrogate to downstream consumers. Passing that through TextEncoder
  // produces U+FFFD bytes, which AivisSpeech synthesizes as an audible buzz.
  it('should not split a UTF-16 surrogate pair at the emit boundary', async () => {
    const fullText = 'a🤔bcd'
    const collectedLiterals: string[] = []

    const parser = useLlmmarkerParser({
      onLiteral(literal) {
        collectedLiterals.push(literal)
      },
    })

    await parser.consume(fullText)
    await parser.end()

    expect(collectedLiterals.join('')).toBe(fullText)
    for (const literal of collectedLiterals) {
      for (let i = 0; i < literal.length; i++) {
        const code = literal.charCodeAt(i)
        if (code >= 0xD800 && code <= 0xDBFF) {
          const next = literal.charCodeAt(i + 1)
          expect(next >= 0xDC00 && next <= 0xDFFF).toBe(true)
          i += 1
        }
        else {
          expect(code >= 0xDC00 && code <= 0xDFFF).toBe(false)
        }
      }
    }
  })
})
