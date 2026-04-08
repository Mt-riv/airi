import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSessionWatcher } from './session-watcher'

function jsonlLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`
}

function userEvent(uuid: string, text: string) {
  return {
    type: 'user',
    uuid,
    sessionId: 'session-test',
    message: { role: 'user', content: text },
  }
}

function assistantText(uuid: string, text: string) {
  return {
    type: 'assistant',
    uuid,
    sessionId: 'session-test',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = fn()
    if (value != null && (!Array.isArray(value) || value.length > 0))
      return value as T
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timed out')
}

describe('createSessionWatcher', () => {
  let workDir: string
  let filePath: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'airi-cc-watcher-'))
    filePath = join(workDir, 'session.jsonl')
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('emits normalised events for all lines already present when started', async () => {
    await writeFile(
      filePath,
      jsonlLine(userEvent('u-1', 'hello'))
      + jsonlLine(assistantText('a-1', 'hi there')),
    )

    const received: string[] = []
    const watcher = createSessionWatcher({
      filePath,
      onEvent: event => received.push(event.kind),
    })

    try {
      await watcher.start()
      await waitFor(() => (received.length >= 2 ? received : null))
      expect(received).toEqual(['user-text', 'assistant-text'])
    }
    finally {
      await watcher.stop()
    }
  })

  it('emits events as new lines are appended', async () => {
    await writeFile(filePath, jsonlLine(userEvent('u-1', 'hello')))

    const received: string[] = []
    const watcher = createSessionWatcher({
      filePath,
      onEvent: event => received.push(event.kind),
    })

    try {
      await watcher.start()
      await waitFor(() => (received.length >= 1 ? received : null))

      await appendFile(filePath, jsonlLine(assistantText('a-1', 'response')))
      await waitFor(() => (received.length >= 2 ? received : null))

      expect(received).toEqual(['user-text', 'assistant-text'])
    }
    finally {
      await watcher.stop()
    }
  })

  it('does not re-emit events after stop is called', async () => {
    await writeFile(filePath, jsonlLine(userEvent('u-1', 'hello')))

    const received: string[] = []
    const watcher = createSessionWatcher({
      filePath,
      onEvent: event => received.push(event.kind),
    })

    await watcher.start()
    await waitFor(() => (received.length >= 1 ? received : null))
    await watcher.stop()

    const countAfterStop = received.length
    await appendFile(filePath, jsonlLine(assistantText('a-1', 'response')))
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(received.length).toBe(countAfterStop)
  })

  it('survives partial line writes and only emits once a newline arrives', async () => {
    await writeFile(filePath, '')

    const received: string[] = []
    const watcher = createSessionWatcher({
      filePath,
      onEvent: event => received.push(event.kind),
    })

    try {
      await watcher.start()

      // Partial JSON without trailing newline — must NOT be parsed yet.
      await appendFile(filePath, '{"type":"user","uuid":"u-1","message"')
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(received).toEqual([])

      // Complete the line.
      await appendFile(filePath, ':{"role":"user","content":"hi"}}\n')
      await waitFor(() => (received.length >= 1 ? received : null))

      expect(received).toEqual(['user-text'])
    }
    finally {
      await watcher.stop()
    }
  })

  it('surfaces parse errors through onEvent as unknown events without crashing', async () => {
    await writeFile(filePath, 'this-is-not-json\n')

    const received: string[] = []
    const watcher = createSessionWatcher({
      filePath,
      onEvent: event => received.push(event.kind),
    })

    try {
      await watcher.start()
      await waitFor(() => (received.length >= 1 ? received : null))
      expect(received).toContain('unknown')
    }
    finally {
      await watcher.stop()
    }
  })

  it('calls onError when the file cannot be opened on start', async () => {
    const missing = join(workDir, 'nope.jsonl')
    const onEvent = vi.fn()
    const onError = vi.fn()

    const watcher = createSessionWatcher({
      filePath: missing,
      onEvent,
      onError,
    })

    await watcher.start()
    await waitFor(() => (onError.mock.calls.length > 0 ? onError.mock.calls : null))

    expect(onError).toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
    await watcher.stop()
  })
})
