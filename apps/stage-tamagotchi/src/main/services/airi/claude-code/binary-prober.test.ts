import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDefaultBinaryProber } from './binary-prober'

class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough()
  public readonly stderr = new PassThrough()
  public readonly pid = 9876
  public killed = false
  public kill(_signal?: string) {
    this.killed = true
    this.stdout.end()
    this.stderr.end()
    return true
  }
}

const spawnMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => FakeChild>())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

describe('createDefaultBinaryProber', () => {
  let fakeChild: FakeChild

  beforeEach(() => {
    fakeChild = new FakeChild()
    spawnMock.mockReset()
    spawnMock.mockReturnValue(fakeChild)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('spawns `<binaryPath> --version` with shell:false and array args', async () => {
    const probe = createDefaultBinaryProber()
    const promise = probe({ binaryPath: '/usr/local/bin/claude' })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>]
    expect(command).toBe('/usr/local/bin/claude')
    expect(args).toEqual(['--version'])
    expect(options).toMatchObject({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] })

    fakeChild.stdout.write('2.1.96 (Claude Code)\n')
    fakeChild.stdout.end()
    fakeChild.emit('exit', 0, null)

    const result = await promise
    expect(result).toEqual({
      ok: true,
      version: '2.1.96 (Claude Code)',
      path: '/usr/local/bin/claude',
    })
  })

  it('returns { ok: false } with stderr message when the binary exits non-zero', async () => {
    const probe = createDefaultBinaryProber()
    const promise = probe({ binaryPath: 'claude' })

    fakeChild.stderr.write('unknown option --version\n')
    fakeChild.stderr.end()
    fakeChild.stdout.end()
    fakeChild.emit('exit', 1, null)

    const result = await promise
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toMatch(/unknown option/i)
  })

  it('returns { ok: false } when spawn itself errors (ENOENT)', async () => {
    const probe = createDefaultBinaryProber()
    const promise = probe({ binaryPath: '/nonexistent/claude' })

    fakeChild.emit('error', new Error('spawn ENOENT'))

    const result = await promise
    expect(result).toEqual({ ok: false, error: 'spawn ENOENT' })
  })

  it('rejects inputs containing a NUL byte before spawning', async () => {
    const probe = createDefaultBinaryProber()
    const result = await probe({ binaryPath: '/bin/claude\u0000evil' })

    expect(spawnMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false })
    if (!result.ok)
      expect(result.error).toMatch(/NUL/i)
  })

  it('times out after 5 seconds and kills the child', async () => {
    const probe = createDefaultBinaryProber()
    const promise = probe({ binaryPath: 'claude' })

    vi.advanceTimersByTime(5001)

    const result = await promise
    expect(fakeChild.killed).toBe(true)
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toMatch(/timed out/i)
  })

  it('falls back to "unknown" when stdout is empty but exit code is zero', async () => {
    const probe = createDefaultBinaryProber()
    const promise = probe({ binaryPath: 'claude' })

    fakeChild.stdout.end()
    fakeChild.stderr.end()
    fakeChild.emit('exit', 0, null)

    const result = await promise
    expect(result).toMatchObject({ ok: true, version: 'unknown' })
  })
})
