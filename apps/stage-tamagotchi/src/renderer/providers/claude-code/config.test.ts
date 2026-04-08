import { describe, expect, it } from 'vitest'

import { claudeCodeConfigSchema } from './config'

describe('claudeCodeConfigSchema', () => {
  it('accepts a valid minimal config', () => {
    const parsed = claudeCodeConfigSchema.parse({
      binaryPath: '/usr/local/bin/claude',
      projectDir: '/Users/dev/airi',
    })

    expect(parsed).toMatchObject({
      binaryPath: '/usr/local/bin/claude',
      projectDir: '/Users/dev/airi',
    })
    expect(parsed.sessionId).toBeUndefined()
  })

  it('defaults binaryPath to "claude" when omitted', () => {
    const parsed = claudeCodeConfigSchema.parse({
      projectDir: '/Users/dev/airi',
    })
    expect(parsed.binaryPath).toBe('claude')
  })

  it('trims whitespace from string fields', () => {
    const parsed = claudeCodeConfigSchema.parse({
      binaryPath: '  claude  ',
      projectDir: '  /Users/dev/airi  ',
      sessionId: '  abc-123  ',
    })
    expect(parsed.binaryPath).toBe('claude')
    expect(parsed.projectDir).toBe('/Users/dev/airi')
    expect(parsed.sessionId).toBe('abc-123')
  })

  it('rejects an empty projectDir (required)', () => {
    const result = claudeCodeConfigSchema.safeParse({ projectDir: '' })
    expect(result.success).toBe(false)
  })

  it('rejects a missing projectDir', () => {
    const result = claudeCodeConfigSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects a whitespace-only binaryPath when explicitly provided', () => {
    const result = claudeCodeConfigSchema.safeParse({
      binaryPath: '   ',
      projectDir: '/Users/dev/airi',
    })
    expect(result.success).toBe(false)
  })

  it('accepts an optional sessionId', () => {
    const parsed = claudeCodeConfigSchema.parse({
      projectDir: '/Users/dev/airi',
      sessionId: 'abc-123-def',
    })
    expect(parsed.sessionId).toBe('abc-123-def')
  })
})
