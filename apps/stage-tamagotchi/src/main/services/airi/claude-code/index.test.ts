import type { NormalizedClaudeCodeEvent } from './types'

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClaudeCodeManager } from './index'

function jsonl(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = fn()
    if (value != null && (!Array.isArray(value) || value.length > 0))
      return value as T
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timed out')
}

describe('createClaudeCodeManager', () => {
  let projectsRoot: string
  let projectDir: string
  let slugDir: string

  beforeEach(async () => {
    // Build a fake `~/.claude/projects/<slug>/` layout so we can exercise
    // listSessions / attachSession without touching the real home directory.
    const workRoot = await mkdtemp(join(tmpdir(), 'airi-cc-manager-'))
    projectDir = join(workRoot, 'project_dir')
    await mkdir(projectDir, { recursive: true })
    projectsRoot = join(workRoot, 'claude-projects')
    // Slug of projectDir: the real projectDir is a tmpdir path, and the
    // manager is configured with projectsRoot + the slug, so we derive the
    // expected directory and mkdir it directly to avoid depending on the
    // slug algorithm under test.
    const { projectSlugFor } = await import('./project-slug')
    const slug = await projectSlugFor(projectDir)
    slugDir = join(projectsRoot, slug)
    await mkdir(slugDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(projectsRoot, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  })

  it('lists sessions by scanning the slug directory', async () => {
    await writeFile(
      join(slugDir, 'session-a.jsonl'),
      jsonl({ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hi' } }),
    )
    await writeFile(
      join(slugDir, 'session-b.jsonl'),
      jsonl({ type: 'user', uuid: 'u-2', message: { role: 'user', content: 'bye' } }),
    )

    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot: projectsRoot,
    })

    const sessions = await manager.listSessions({ projectDir })

    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.meta.sessionId).sort()).toEqual(['session-a', 'session-b'])
    for (const session of sessions) {
      expect(session.meta.slug).toBeDefined()
      expect(session.meta.filePath).toMatch(/session-[ab]\.jsonl$/)
    }
  })

  it('returns an empty list when the slug directory does not exist', async () => {
    const missingProject = join(projectsRoot, '..', 'never-opened')
    await mkdir(missingProject, { recursive: true })

    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot: projectsRoot,
    })

    const sessions = await manager.listSessions({ projectDir: missingProject })
    expect(sessions).toEqual([])
  })

  it('attachSession starts a watcher and streams normalised events to subscribers', async () => {
    const sessionFile = join(slugDir, 'session-live.jsonl')
    await writeFile(sessionFile, jsonl({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'hello' },
    }))

    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot: projectsRoot,
    })

    const received: Array<{ sessionId: string, event: NormalizedClaudeCodeEvent }> = []
    const unsubscribe = manager.onEvent((sessionId, event) => {
      received.push({ sessionId, event })
    })

    try {
      await manager.attachSession({ sessionId: 'session-live', projectDir })
      await waitFor(() => (received.length >= 1 ? received : null))

      expect(received[0]).toMatchObject({
        sessionId: 'session-live',
        event: expect.objectContaining({ kind: 'user-text', text: 'hello' }),
      })

      await appendFile(sessionFile, jsonl({
        type: 'assistant',
        uuid: 'a-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
      }))

      await waitFor(() => (received.length >= 2 ? received : null))
      expect(received[1].event).toMatchObject({ kind: 'assistant-text', text: 'world' })
    }
    finally {
      unsubscribe()
      await manager.stopAll()
    }
  })

  it('detachSession stops streaming further events for that session', async () => {
    const sessionFile = join(slugDir, 'session-detach.jsonl')
    await writeFile(sessionFile, jsonl({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'hi' },
    }))

    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot: projectsRoot,
    })

    const received: NormalizedClaudeCodeEvent[] = []
    manager.onEvent((_sessionId, event) => received.push(event))

    await manager.attachSession({ sessionId: 'session-detach', projectDir })
    await waitFor(() => (received.length >= 1 ? received : null))
    const countBeforeDetach = received.length

    await manager.detachSession({ sessionId: 'session-detach' })
    await appendFile(sessionFile, jsonl({
      type: 'assistant',
      uuid: 'a-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] },
    }))
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(received.length).toBe(countBeforeDetach)
    await manager.stopAll()
  })

  it('attachSession is idempotent — calling twice does not duplicate events', async () => {
    const sessionFile = join(slugDir, 'session-idem.jsonl')
    await writeFile(sessionFile, jsonl({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'once' },
    }))

    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot: projectsRoot,
    })

    const received: NormalizedClaudeCodeEvent[] = []
    manager.onEvent((_sessionId, event) => received.push(event))

    try {
      await manager.attachSession({ sessionId: 'session-idem', projectDir })
      await manager.attachSession({ sessionId: 'session-idem', projectDir })

      await waitFor(() => (received.length >= 1 ? received : null))
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(received.filter(e => e.kind === 'user-text')).toHaveLength(1)
    }
    finally {
      await manager.stopAll()
    }
  })

  it('sendPrompt delegates to a runner factory and surfaces emitted events', async () => {
    // Build a fake runner so we don't actually spawn `claude`.
    type RunnerListener = (event: NormalizedClaudeCodeEvent) => void
    const listeners = new Set<RunnerListener>()
    const sendPromptMock = vi.fn(async ({ sessionId }: { sessionId: string | null }) => {
      listeners.forEach(l => l({
        kind: 'assistant-text',
        uuid: 'from-runner',
        text: 'hi from fake runner',
        raw: {},
      }))
      return { ok: true as const, sessionId: sessionId ?? 'generated-session-id' }
    })
    const runnerFactory = vi.fn(() => ({
      sendPrompt: sendPromptMock,
      onEvent: (listener: RunnerListener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      stop: vi.fn(async () => { /* no-op */ }),
    }))

    const manager = createClaudeCodeManager({
      binaryPath: '/fake/claude',
      claudeProjectsRoot: projectsRoot,
      runnerFactory,
    })

    const received: Array<{ sessionId: string, event: NormalizedClaudeCodeEvent }> = []
    manager.onEvent((sessionId, event) => received.push({ sessionId, event }))

    const result = await manager.sendPrompt({
      projectDir,
      sessionId: null,
      text: 'hi',
    })

    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.sessionId).toBe('generated-session-id')
    expect(runnerFactory).toHaveBeenCalledWith(expect.objectContaining({
      binaryPath: '/fake/claude',
      projectDir,
    }))
    expect(sendPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      text: 'hi',
      sessionId: null,
    }))
    expect(received).toEqual([
      expect.objectContaining({
        sessionId: 'generated-session-id',
        event: expect.objectContaining({ kind: 'assistant-text', text: 'hi from fake runner' }),
      }),
    ])

    await manager.stopAll()
  })

  it('checkBinary delegates to the injected binaryProber', async () => {
    const binaryProber = vi.fn(async () => ({ ok: true as const, version: '2.1.96', path: 'claude' }))
    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot: projectsRoot,
      binaryProber,
    })

    const result = await manager.checkBinary({ binaryPath: '/usr/local/bin/claude' })

    expect(binaryProber).toHaveBeenCalledWith({ binaryPath: '/usr/local/bin/claude' })
    expect(result).toEqual({ ok: true, version: '2.1.96', path: 'claude' })
  })

  it('checkBinary surfaces prober failures verbatim', async () => {
    const binaryProber = vi.fn(async () => ({ ok: false as const, error: 'spawn ENOENT' }))
    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot: projectsRoot,
      binaryProber,
    })

    const result = await manager.checkBinary({ binaryPath: '/nope/claude' })
    expect(result).toEqual({ ok: false, error: 'spawn ENOENT' })
  })

  it('resolveSlug returns { ok: true, realPath, slug } for an existing directory', async () => {
    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot: projectsRoot,
    })

    const result = await manager.resolveSlug({ projectDir })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.realPath).toBeTruthy()
      // The slug is a lossy hyphen-flattened form of the realpath.
      expect(result.slug).toMatch(/^-/)
      expect(result.slug).not.toContain('/')
      expect(result.slug).not.toContain('_')
      expect(result.slug).not.toContain('.')
    }
  })

  it('resolveSlug returns { ok: false, error } for a missing directory', async () => {
    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot: projectsRoot,
    })

    const result = await manager.resolveSlug({ projectDir: join(projectsRoot, '..', 'does-not-exist') })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toMatch(/ENOENT|no such/i)
  })
})
