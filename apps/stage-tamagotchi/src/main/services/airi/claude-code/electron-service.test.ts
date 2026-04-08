import type {
  ClaudeCodeSendPromptResult,
  ClaudeCodeSession,
  ClaudeCodeSessionMeta,
  NormalizedClaudeCodeEvent,
} from '../../../../shared/claude-code'
import type {
  AttachSessionInput,
  ClaudeCodeManager,
  DetachSessionInput,
  ListSessionsInput,
  ManagerEventListener,
  SendManagerPromptInput,
} from './index'

import { defineInvoke } from '@moeru/eventa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  claudeCodeAttachSession,
  claudeCodeCheckBinary,
  claudeCodeDetachSession,
  claudeCodeListSessions,
  claudeCodeResolveSlug,
  claudeCodeSendPrompt,
  claudeCodeStreamEvent,
} from '../../../../shared/eventa'
import { createClaudeCodeService } from './electron-service'

// NOTICE: mirror the plugins test setup — swap the Electron-bound
//         createContext for a pure in-memory eventa context so we can drive
//         handlers and broadcasts without starting a real BrowserWindow.
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  ipcMain: {},
}))

const contextState = vi.hoisted(() => ({
  lastContext: undefined as ReturnType<typeof import('@moeru/eventa').createContext<any, any>> | undefined,
}))

vi.mock('@moeru/eventa/adapters/electron/main', async () => {
  const eventa = await import('@moeru/eventa')
  return {
    createContext: () => {
      const context = eventa.createContext()
      contextState.lastContext = context
      return { context, dispose: () => {} }
    },
  }
})

vi.mock('../../../libs/bootkit/lifecycle', () => ({
  onAppBeforeQuit: vi.fn(),
}))

interface FakeManager extends ClaudeCodeManager {
  emit: (sessionId: string, event: NormalizedClaudeCodeEvent) => void
}

function createFakeManager(overrides: Partial<ClaudeCodeManager> = {}): FakeManager {
  const listeners = new Set<ManagerEventListener>()

  const defaultListSessions = vi.fn<(input: ListSessionsInput) => Promise<ClaudeCodeSession[]>>(async () => [])
  const defaultAttach = vi.fn<(input: AttachSessionInput) => Promise<ClaudeCodeSessionMeta>>(async input => ({
    sessionId: input.sessionId,
    slug: 'test-slug',
    filePath: `/fake/${input.sessionId}.jsonl`,
    cwd: input.projectDir,
    eventCount: 0,
  }))
  const defaultDetach = vi.fn<(input: DetachSessionInput) => Promise<void>>(async () => {})
  const defaultSendPrompt = vi.fn<(input: SendManagerPromptInput) => Promise<ClaudeCodeSendPromptResult>>(
    async input => ({ ok: true, sessionId: input.sessionId ?? 'generated' }),
  )
  const defaultCheckBinary = vi.fn<ClaudeCodeManager['checkBinary']>(async () => ({ ok: true, version: '2.1.96', path: 'claude' }))
  const defaultResolveSlug = vi.fn<ClaudeCodeManager['resolveSlug']>(async input => ({
    ok: true,
    realPath: input.projectDir,
    slug: `-fake-${input.projectDir.replace(/[/._]+/g, '-')}`,
  }))

  return {
    listSessions: defaultListSessions,
    attachSession: defaultAttach,
    detachSession: defaultDetach,
    sendPrompt: defaultSendPrompt,
    checkBinary: defaultCheckBinary,
    resolveSlug: defaultResolveSlug,
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stopAll: vi.fn(async () => {}),
    ...overrides,
    emit: (sessionId, event) => {
      listeners.forEach(l => l(sessionId, event))
    },
  }
}

async function createTestContext() {
  const eventa = await import('@moeru/eventa')
  const context = eventa.createContext()
  contextState.lastContext = context
  // NOTICE: `createClaudeCodeService` is typed against the Electron-adapted
  //         context (with a required `raw: { ipcMainEvent }` options shape).
  //         Pure eventa's createContext returns a more permissive shape, so
  //         we cast here to keep the test in-memory without dragging in a
  //         real BrowserWindow.
  return context as unknown as Parameters<typeof import('./electron-service').createClaudeCodeService>[0]['context']
}

describe('createClaudeCodeService', () => {
  let unsubscribe: (() => void) | undefined

  beforeEach(() => {
    contextState.lastContext = undefined
  })

  afterEach(() => {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = undefined
    }
    vi.clearAllMocks()
  })

  it('routes claudeCodeListSessions invokes to manager.listSessions', async () => {
    const context = await createTestContext()
    const fake = createFakeManager({
      listSessions: vi.fn(async () => [
        {
          meta: {
            sessionId: 'sess-1',
            slug: '-fake-slug',
            filePath: '/fake/sess-1.jsonl',
            eventCount: 0,
          },
          running: false,
        },
      ]),
    })
    unsubscribe = createClaudeCodeService({ context, manager: fake })

    const invoke = defineInvoke(context, claudeCodeListSessions)
    const result = await invoke({ projectDir: '/projects/airi' })

    expect(fake.listSessions).toHaveBeenCalledWith({ projectDir: '/projects/airi' })
    expect(result).toHaveLength(1)
    expect(result?.[0].meta.sessionId).toBe('sess-1')
  })

  it('routes claudeCodeAttachSession invokes to manager.attachSession', async () => {
    const context = await createTestContext()
    const fake = createFakeManager()
    unsubscribe = createClaudeCodeService({ context, manager: fake })

    const invoke = defineInvoke(context, claudeCodeAttachSession)
    const meta = await invoke({ sessionId: 'sess-2', projectDir: '/projects/airi' })

    expect(fake.attachSession).toHaveBeenCalledWith({
      sessionId: 'sess-2',
      projectDir: '/projects/airi',
    })
    expect(meta?.sessionId).toBe('sess-2')
  })

  it('routes claudeCodeDetachSession invokes to manager.detachSession', async () => {
    const context = await createTestContext()
    const fake = createFakeManager()
    unsubscribe = createClaudeCodeService({ context, manager: fake })

    const invoke = defineInvoke(context, claudeCodeDetachSession)
    await invoke({ sessionId: 'sess-3' })

    expect(fake.detachSession).toHaveBeenCalledWith({ sessionId: 'sess-3' })
  })

  it('routes claudeCodeSendPrompt invokes and returns the result verbatim', async () => {
    const context = await createTestContext()
    const fake = createFakeManager({
      sendPrompt: vi.fn(async () => ({ ok: true, sessionId: 'runtime-session' } as const)),
    })
    unsubscribe = createClaudeCodeService({ context, manager: fake })

    const invoke = defineInvoke(context, claudeCodeSendPrompt)
    const result = await invoke({ projectDir: '/projects/airi', sessionId: null, text: 'hello' })

    expect(fake.sendPrompt).toHaveBeenCalledWith({
      projectDir: '/projects/airi',
      sessionId: null,
      text: 'hello',
    })
    expect(result).toEqual({ ok: true, sessionId: 'runtime-session' })
  })

  it('converts thrown errors in sendPrompt into a structured { ok: false } result', async () => {
    const context = await createTestContext()
    const fake = createFakeManager({
      sendPrompt: vi.fn(async () => {
        throw new Error('claude binary missing')
      }),
    })
    unsubscribe = createClaudeCodeService({ context, manager: fake })

    const invoke = defineInvoke(context, claudeCodeSendPrompt)
    const result = await invoke({ projectDir: '/projects/airi', sessionId: 'abc', text: 'hi' })

    expect(result).toEqual({
      ok: false,
      error: 'claude binary missing',
      sessionId: 'abc',
    })
  })

  it('routes claudeCodeCheckBinary invokes to manager.checkBinary', async () => {
    const context = await createTestContext()
    const fake = createFakeManager({
      checkBinary: vi.fn(async () => ({ ok: true as const, version: '2.1.96', path: '/usr/local/bin/claude' })),
    })
    unsubscribe = createClaudeCodeService({ context, manager: fake })

    const invoke = defineInvoke(context, claudeCodeCheckBinary)
    const result = await invoke({ binaryPath: '/usr/local/bin/claude' })

    expect(fake.checkBinary).toHaveBeenCalledWith({ binaryPath: '/usr/local/bin/claude' })
    expect(result).toEqual({ ok: true, version: '2.1.96', path: '/usr/local/bin/claude' })
  })

  it('converts thrown errors from checkBinary into { ok: false } results', async () => {
    const context = await createTestContext()
    const fake = createFakeManager({
      checkBinary: vi.fn(async () => {
        throw new Error('unexpected probe failure')
      }),
    })
    unsubscribe = createClaudeCodeService({ context, manager: fake })

    const invoke = defineInvoke(context, claudeCodeCheckBinary)
    const result = await invoke({ binaryPath: 'claude' })

    expect(result).toEqual({ ok: false, error: 'unexpected probe failure' })
  })

  it('routes claudeCodeResolveSlug invokes to manager.resolveSlug', async () => {
    const context = await createTestContext()
    const fake = createFakeManager()
    unsubscribe = createClaudeCodeService({ context, manager: fake })

    const invoke = defineInvoke(context, claudeCodeResolveSlug)
    const result = await invoke({ projectDir: '/Users/dev/airi' })

    expect(fake.resolveSlug).toHaveBeenCalledWith({ projectDir: '/Users/dev/airi' })
    expect(result?.ok).toBe(true)
  })

  it('forwards manager events onto the claudeCodeStreamEvent broadcast', async () => {
    const context = await createTestContext()
    const emitSpy = vi.spyOn(context, 'emit')
    const fake = createFakeManager()
    unsubscribe = createClaudeCodeService({ context, manager: fake })

    fake.emit('sess-broadcast', {
      kind: 'assistant-text',
      uuid: 'a-1',
      text: 'hello from manager',
      raw: {},
    })

    expect(emitSpy).toHaveBeenCalledWith(claudeCodeStreamEvent, {
      sessionId: 'sess-broadcast',
      event: expect.objectContaining({ kind: 'assistant-text', text: 'hello from manager' }),
    })
  })

  it('unsubscribe stops forwarding further manager events', async () => {
    const context = await createTestContext()
    const emitSpy = vi.spyOn(context, 'emit')
    const fake = createFakeManager()
    const stop = createClaudeCodeService({ context, manager: fake })

    fake.emit('sess', { kind: 'user-text', uuid: 'u-1', text: 'one', raw: {} })
    const callsAfterFirst = emitSpy.mock.calls.filter(call => call[0] === claudeCodeStreamEvent).length

    stop()
    fake.emit('sess', { kind: 'user-text', uuid: 'u-2', text: 'two', raw: {} })

    const callsAfterStop = emitSpy.mock.calls.filter(call => call[0] === claudeCodeStreamEvent).length
    expect(callsAfterFirst).toBe(1)
    expect(callsAfterStop).toBe(1)
  })
})
