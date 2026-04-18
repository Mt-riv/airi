import { describe, expect, it } from 'vitest'

import { evaluateSensitivity } from './sensitivity'

describe('evaluateSensitivity', () => {
  it('marks network.fetch as sensitive with no allow-list', () => {
    const result = evaluateSensitivity('network.fetch', { url: 'https://example.com' })
    expect(result.requiresApproval).toBe(true)
    expect(result.reason).toMatch(/network/)
  })

  it('allows network.fetch when URL matches an allow-list pattern', () => {
    const result = evaluateSensitivity(
      'network.fetch',
      { url: 'api.internal.example.com' },
      { networks: ['api.internal.*'] },
    )
    expect(result.requiresApproval).toBe(false)
  })

  it('marks shell.exec as sensitive with no allow-list', () => {
    const result = evaluateSensitivity('shell.exec', { command: 'rm -rf /' })
    expect(result.requiresApproval).toBe(true)
    expect(result.reason).toMatch(/shell/)
  })

  it('marks filesystem.write as sensitive with no allow-list', () => {
    const result = evaluateSensitivity('filesystem.write', { path: '/etc/passwd' })
    expect(result.requiresApproval).toBe(true)
    expect(result.reason).toMatch(/filesystem/)
  })

  it('allows filesystem.write when path matches allow-list pattern', () => {
    const result = evaluateSensitivity(
      'filesystem.write',
      { path: '/tmp/output.txt' },
      { filesystemWrites: ['/tmp/*'] },
    )
    expect(result.requiresApproval).toBe(false)
  })

  it('treats a custom safe tool as non-sensitive', () => {
    const result = evaluateSensitivity('calculator.add', { a: 1, b: 2 })
    expect(result.requiresApproval).toBe(false)
    expect(result.reason).toBeUndefined()
  })

  it('treats an empty allow-list as if no allow-list was provided (still sensitive)', () => {
    const result = evaluateSensitivity('network.get', { url: 'https://example.com' }, {})
    expect(result.requiresApproval).toBe(true)
  })

  it('allows shell command when it matches allow-list pattern', () => {
    const result = evaluateSensitivity(
      'shell',
      { command: 'echo hello world' },
      { shellCommands: ['echo *'] },
    )
    expect(result.requiresApproval).toBe(false)
  })

  it('marks bare exec as sensitive', () => {
    const result = evaluateSensitivity('exec', { command: 'ls' })
    expect(result.requiresApproval).toBe(true)
  })

  it('does not allow network.fetch when URL does not match allow-list', () => {
    const result = evaluateSensitivity(
      'network.fetch',
      { url: 'evil.attacker.com' },
      { networks: ['api.internal.*'] },
    )
    expect(result.requiresApproval).toBe(true)
  })
})
