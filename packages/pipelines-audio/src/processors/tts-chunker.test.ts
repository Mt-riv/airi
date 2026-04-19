import { describe, expect, it } from 'vitest'

import { chunkTtsInput } from './tts-chunker'

async function collect(input: string) {
  const out: string[] = []
  for await (const chunk of chunkTtsInput(input, { boost: 0, minimumWords: 0, maximumWords: 100 }))
    out.push(chunk.text)
  return out
}

describe('chunkTtsInput emoji handling', () => {
  it('drops BMP pictographs (✨) so they never reach the TTS engine', async () => {
    const chunks = await collect('こんにちは✨世界。')
    expect(chunks.join('|')).not.toContain('✨')
    expect(chunks.join('')).toContain('こんにちは')
    expect(chunks.join('')).toContain('世界')
  })

  it('drops surrogate-pair emoji (🌟) as well', async () => {
    const chunks = await collect('やったー🌟すごい！')
    expect(chunks.join('|')).not.toContain('🌟')
    expect(chunks.join('')).toContain('やったー')
    expect(chunks.join('')).toContain('すごい')
  })

  it('keeps regular letters and kana intact', async () => {
    const chunks = await collect('Hello あいう.')
    expect(chunks.join('')).toContain('Hello')
    expect(chunks.join('')).toContain('あいう')
  })
})
