import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSessionRunner } from './session-runner'

// Lightweight fake replacement for `child_process.ChildProcess`.
class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough()
  public readonly stderr = new PassThrough()
  public readonly pid = 4242
  public killed = false
  public kill(_signal?: string) {
    this.killed = true
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', 0, null)
    this.emit('close', 0, null)
    return true
  }
}

const spawnMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => FakeChild>())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

function jsonl(payload: unknown) {
  return `${JSON.stringify(payload)}\n`
}

describe('createSessionRunner', () => {
  let fakeChild: FakeChild

  beforeEach(() => {
    fakeChild = new FakeChild()
    spawnMock.mockReset()
    spawnMock.mockReturnValue(fakeChild)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('spawns the claude binary with safe array arguments when starting a new session', async () => {
    const runner = createSessionRunner({
      binaryPath: '/usr/local/bin/claude',
      projectDir: '/Users/dev/airi',
    })

    const promise = runner.sendPrompt({ text: 'hello', sessionId: null })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>]
    expect(command).toBe('/usr/local/bin/claude')
    expect(args).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
    expect(options).toMatchObject({
      cwd: '/Users/dev/airi',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Finish the fake process so the promise resolves.
    fakeChild.stdout.end()
    fakeChild.emit('exit', 0, null)
    await promise
  })

  it('includes --resume when a session id is provided', async () => {
    const runner = createSessionRunner({
      binaryPath: 'claude',
      projectDir: '/tmp/work',
    })

    const promise = runner.sendPrompt({ text: 'add', sessionId: 'abc-123' })

    const [, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(args).toContain('--resume')
    expect(args).toContain('abc-123')

    fakeChild.stdout.end()
    fakeChild.emit('exit', 0, null)
    await promise
  })

  it('resolves the session id from the first system.init line', async () => {
    const runner = createSessionRunner({
      binaryPath: 'claude',
      projectDir: '/tmp',
    })

    const received: string[] = []
    runner.onEvent((event) => {
      received.push(event.kind)
    })

    const promise = runner.sendPrompt({ text: 'hi', sessionId: null })

    fakeChild.stdout.write(jsonl({ type: 'system', subtype: 'init', session_id: 'session-new', model: 'claude-opus-4-6' }))
    fakeChild.stdout.write(jsonl({
      type: 'assistant',
      uuid: 'a-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    }))
    fakeChild.stdout.write(jsonl({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'hello' }))
    fakeChild.stdout.end()
    fakeChild.emit('exit', 0, null)

    const result = await promise
    expect(result.sessionId).toBe('session-new')
    expect(received).toContain('assistant-text')
    expect(received).toContain('finish')
  })

  it('returns an error result when the process exits non-zero', async () => {
    const runner = createSessionRunner({
      binaryPath: 'claude',
      projectDir: '/tmp',
    })

    const promise = runner.sendPrompt({ text: 'hi', sessionId: null })

    fakeChild.stderr.write('boom\n')
    fakeChild.stderr.end()
    fakeChild.stdout.end()
    fakeChild.emit('exit', 2, null)

    const result = await promise
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toMatch(/boom|exit/i)
  })

  it('stop() kills the spawned process', async () => {
    const runner = createSessionRunner({
      binaryPath: 'claude',
      projectDir: '/tmp',
    })

    const promise = runner.sendPrompt({ text: 'long', sessionId: null })
    expect(fakeChild.killed).toBe(false)

    await runner.stop()
    expect(fakeChild.killed).toBe(true)
    await promise
  })

  it('rejects obviously malformed inputs before spawning (NUL byte)', async () => {
    const runner = createSessionRunner({
      binaryPath: 'claude',
      projectDir: '/tmp',
    })

    await expect(
      runner.sendPrompt({ text: 'hello\u0000world', sessionId: null }),
    ).rejects.toThrow(/NUL/i)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
