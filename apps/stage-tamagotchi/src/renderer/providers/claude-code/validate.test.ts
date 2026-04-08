import type { ClaudeCodeTransport } from './provider'

import { describe, expect, it, vi } from 'vitest'

import { validateClaudeCodeConfig } from './validate'

function createValidatorTransport(overrides: Partial<ClaudeCodeTransport> = {}): ClaudeCodeTransport {
  return {
    sendPrompt: vi.fn(async () => ({ ok: true as const, sessionId: 'ignored' })),
    onStreamEvent: vi.fn(() => () => {}),
    checkBinary: vi.fn(async () => ({ ok: true as const, version: '2.1.96', path: 'claude' })),
    resolveSlug: vi.fn(async input => ({
      ok: true as const,
      realPath: input.projectDir,
      slug: '-fake-slug',
    })),
    ...overrides,
  }
}

describe('validateClaudeCodeConfig', () => {
  it('returns valid when projectDir resolves and binary probe succeeds', async () => {
    const transport = createValidatorTransport()
    const result = await validateClaudeCodeConfig(
      { projectDir: '/Users/dev/airi', binaryPath: 'claude' },
      transport,
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(transport.resolveSlug).toHaveBeenCalledWith({ projectDir: '/Users/dev/airi' })
    expect(transport.checkBinary).toHaveBeenCalledWith({ binaryPath: 'claude' })
  })

  it('reports an error when projectDir is missing', async () => {
    const transport = createValidatorTransport()
    const result = await validateClaudeCodeConfig({}, transport)
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        errorKey: expect.stringContaining('project-dir-required'),
      }),
    ]))
    // When projectDir is missing, resolveSlug should NOT be called.
    expect(transport.resolveSlug).not.toHaveBeenCalled()
  })

  it('reports an error when resolveSlug returns { ok: false }', async () => {
    const transport = createValidatorTransport({
      resolveSlug: vi.fn(async () => ({ ok: false as const, error: 'ENOENT: no such file or directory' })),
    })
    const result = await validateClaudeCodeConfig(
      { projectDir: '/not/a/real/dir' },
      transport,
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        errorKey: expect.stringContaining('project-dir-unreadable'),
      }),
    ]))
  })

  it('reports an error when checkBinary returns { ok: false }', async () => {
    const transport = createValidatorTransport({
      checkBinary: vi.fn(async () => ({ ok: false as const, error: 'spawn ENOENT' })),
    })
    const result = await validateClaudeCodeConfig(
      { projectDir: '/Users/dev/airi', binaryPath: '/nope/claude' },
      transport,
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        errorKey: expect.stringContaining('binary-not-found'),
      }),
    ]))
    // The reason summary should include the underlying error for UI tooltips.
    expect(result.reason).toContain('spawn ENOENT')
  })

  it('defaults binaryPath to "claude" when the user left it blank', async () => {
    const transport = createValidatorTransport()
    await validateClaudeCodeConfig(
      { projectDir: '/Users/dev/airi', binaryPath: '   ' },
      transport,
    )
    expect(transport.checkBinary).toHaveBeenCalledWith({ binaryPath: 'claude' })
  })

  it('converts transport exceptions into structured error entries', async () => {
    const transport = createValidatorTransport({
      resolveSlug: vi.fn(async () => {
        throw new Error('IPC connection dropped')
      }),
      checkBinary: vi.fn(async () => {
        throw new Error('renderer not ready')
      }),
    })
    const result = await validateClaudeCodeConfig(
      { projectDir: '/Users/dev/airi', binaryPath: 'claude' },
      transport,
    )
    expect(result.valid).toBe(false)
    const errorKeys = result.errors.map(e => e.errorKey)
    expect(errorKeys).toEqual(expect.arrayContaining([
      expect.stringContaining('resolve-slug-transport'),
      expect.stringContaining('check-binary-transport'),
    ]))
  })

  it('uses the translator when a key resolves to a distinct localised string', async () => {
    const translations: Record<string, string> = {
      'settings.pages.providers.provider.claude-code.errors.binary-not-found': 'Claude Code バイナリが見つかりません',
    }
    const t = ((key: string) => translations[key] ?? key) as any
    const transport = createValidatorTransport({
      checkBinary: vi.fn(async () => ({ ok: false as const, error: 'spawn ENOENT' })),
    })
    const result = await validateClaudeCodeConfig(
      { projectDir: '/Users/dev/airi', binaryPath: '/nope' },
      transport,
      t,
    )
    expect(result.valid).toBe(false)
    const messages = result.errors.map(e => (e.error as Error).message)
    expect(messages.some(message => message.includes('Claude Code バイナリが見つかりません'))).toBe(true)
  })

  it('falls back to the English default when t() returns the key unchanged', async () => {
    const t = ((key: string) => key) as any
    const transport = createValidatorTransport({
      checkBinary: vi.fn(async () => ({ ok: false as const, error: 'boom' })),
    })
    const result = await validateClaudeCodeConfig(
      { projectDir: '/Users/dev/airi' },
      transport,
      t,
    )
    const messages = result.errors.map(e => (e.error as Error).message)
    expect(messages.some(message => message.includes('Claude Code binary is not usable'))).toBe(true)
  })
})
