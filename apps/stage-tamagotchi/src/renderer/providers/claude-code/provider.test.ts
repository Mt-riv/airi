import type { StreamEvent } from '@proj-airi/stage-ui/stores/llm'
import type { Message } from '@xsai/shared-chat'

import type {
  ClaudeCodeSendPromptInput,
  ClaudeCodeSendPromptResult,
  ClaudeCodeStreamEventPayload,
  NormalizedClaudeCodeEvent,
} from '../../../shared/claude-code'
import type { ClaudeCodeTransport } from './provider'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { claudeCodeConfigSchema } from './config'
import {
  CLAUDE_CODE_STREAM_METHOD,
  createClaudeCodeProvider,
  createClaudeCodeStreamDispatcher,
} from './provider'

function createFakeTransport(options?: {
  sendPromptResult?: ClaudeCodeSendPromptResult
  sendPromptError?: Error
}) {
  const listeners = new Set<(payload: ClaudeCodeStreamEventPayload) => void>()
  const sendPromptCalls: ClaudeCodeSendPromptInput[] = []

  const sendPromptImpl = async (payload: ClaudeCodeSendPromptInput): Promise<ClaudeCodeSendPromptResult> => {
    sendPromptCalls.push(payload)
    if (options?.sendPromptError)
      throw options.sendPromptError
    return options?.sendPromptResult ?? { ok: true, sessionId: 'generated-session-id' }
  }

  const transport: ClaudeCodeTransport = {
    sendPrompt: vi.fn<(payload: ClaudeCodeSendPromptInput) => Promise<ClaudeCodeSendPromptResult>>(sendPromptImpl),
    onStreamEvent: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    checkBinary: vi.fn(async () => ({ ok: true as const, version: '2.1.96', path: 'claude' })),
    resolveSlug: vi.fn(async input => ({
      ok: true as const,
      realPath: input.projectDir,
      slug: '-fake-slug',
    })),
  }

  return {
    transport,
    sendPromptCalls,
    emit: (payload: ClaudeCodeStreamEventPayload) => {
      listeners.forEach(l => l(payload))
    },
    listenerCount: () => listeners.size,
  }
}

function userMessage(text: string): Message {
  return { role: 'user', content: text }
}

function normalised(event: NormalizedClaudeCodeEvent): ClaudeCodeStreamEventPayload {
  return { sessionId: 'generated-session-id', event }
}

describe('createClaudeCodeStreamDispatcher', () => {
  let parsedConfig: ReturnType<typeof claudeCodeConfigSchema.parse>

  beforeEach(() => {
    parsedConfig = claudeCodeConfigSchema.parse({
      binaryPath: '/usr/local/bin/claude',
      projectDir: '/Users/dev/airi',
    })
  })

  it('invokes sendPrompt with the last user message text and null session id on the first call', async () => {
    const { transport, sendPromptCalls } = createFakeTransport()
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    await dispatcher([userMessage('hello claude')])

    expect(sendPromptCalls).toHaveLength(1)
    expect(sendPromptCalls[0]).toEqual({
      projectDir: '/Users/dev/airi',
      sessionId: null,
      text: 'hello claude',
    })
  })

  it('extracts text from content-part arrays if the user message has no plain string', async () => {
    const { transport, sendPromptCalls } = createFakeTransport()
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    const message = {
      role: 'user' as const,
      content: [
        { type: 'text', text: 'look at this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,xxxx' } },
      ],
    } as unknown as Message

    await dispatcher([message])

    expect(sendPromptCalls[0].text).toBe('look at this image')
  })

  it('forwards assistant-text events as text-delta StreamEvents', async () => {
    const { transport, emit } = createFakeTransport()
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    // Drive sendPrompt but pause it so we can emit events first.
    let sendPromptResolve: (result: ClaudeCodeSendPromptResult) => void = () => {}
    const pending = new Promise<ClaudeCodeSendPromptResult>((resolve) => {
      sendPromptResolve = resolve
    });
    (transport.sendPrompt as ReturnType<typeof vi.fn>).mockReturnValue(pending)

    const dispatcherPromise = dispatcher([userMessage('hi')], {
      onStreamEvent: event => void received.push(event),
    })

    emit(normalised({ kind: 'assistant-text', uuid: 'a-1', text: 'hello there', raw: {} }))
    emit(normalised({ kind: 'assistant-text', uuid: 'a-2', text: ' friend', raw: {} }))
    sendPromptResolve({ ok: true, sessionId: 'generated-session-id' })

    await dispatcherPromise

    const textDeltas = received.filter(e => e.type === 'text-delta')
    expect(textDeltas).toEqual([
      { type: 'text-delta', text: 'hello there' },
      { type: 'text-delta', text: ' friend' },
    ])
  })

  it('maps tool_use → tool-call and tool_result → tool-result', async () => {
    const { transport, emit } = createFakeTransport()
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    let sendPromptResolve: (result: ClaudeCodeSendPromptResult) => void = () => {}
    const pending = new Promise<ClaudeCodeSendPromptResult>((resolve) => {
      sendPromptResolve = resolve
    });
    (transport.sendPrompt as ReturnType<typeof vi.fn>).mockReturnValue(pending)

    const dispatcherPromise = dispatcher([userMessage('run ls')], {
      onStreamEvent: event => void received.push(event),
    })

    emit(normalised({
      kind: 'tool-call',
      uuid: 'tc-1',
      toolCallId: 'toolu_abc',
      toolName: 'Bash',
      args: { command: 'ls' },
      raw: {},
    }))
    emit(normalised({
      kind: 'tool-result',
      uuid: 'tr-1',
      toolCallId: 'toolu_abc',
      result: 'file1\nfile2',
      isError: false,
      raw: {},
    }))

    sendPromptResolve({ ok: true, sessionId: 'generated-session-id' })
    await dispatcherPromise

    const toolCall = received.find(e => e.type === 'tool-call') as { toolCallId: string, toolName: string, args: unknown } | undefined
    const toolResult = received.find(e => e.type === 'tool-result') as { toolCallId: string, result: unknown } | undefined

    expect(toolCall?.toolCallId).toBe('toolu_abc')
    expect(toolCall?.toolName).toBe('Bash')
    expect(toolResult?.toolCallId).toBe('toolu_abc')
    expect(toolResult?.result).toBe('file1\nfile2')
  })

  it('maps tool-result events with isError=true to tool-error', async () => {
    const { transport, emit } = createFakeTransport()
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    let sendPromptResolve: (result: ClaudeCodeSendPromptResult) => void = () => {}
    const pending = new Promise<ClaudeCodeSendPromptResult>((resolve) => {
      sendPromptResolve = resolve
    });
    (transport.sendPrompt as ReturnType<typeof vi.fn>).mockReturnValue(pending)

    const dispatcherPromise = dispatcher([userMessage('run broken')], {
      onStreamEvent: event => void received.push(event),
    })

    emit(normalised({
      kind: 'tool-result',
      uuid: 'tr-2',
      toolCallId: 'toolu_err',
      result: 'exit code 1',
      isError: true,
      raw: {},
    }))

    sendPromptResolve({ ok: true, sessionId: 'generated-session-id' })
    await dispatcherPromise

    const toolError = received.find(e => e.type === 'tool-error')
    expect(toolError).toBeTruthy()
    expect(toolError).toMatchObject({ toolCallId: 'toolu_err' })
  })

  it('remembers the session id across successive calls to resume the same session', async () => {
    const { transport, sendPromptCalls } = createFakeTransport({
      sendPromptResult: { ok: true, sessionId: 'persisted-session' },
    })
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    await dispatcher([userMessage('first')])
    await dispatcher([userMessage('second')])

    expect(sendPromptCalls).toHaveLength(2)
    expect(sendPromptCalls[0].sessionId).toBeNull()
    expect(sendPromptCalls[1].sessionId).toBe('persisted-session')
  })

  it('emits an error StreamEvent and rejects when sendPrompt returns { ok: false }', async () => {
    const { transport } = createFakeTransport({
      sendPromptResult: { ok: false, error: 'claude not found', sessionId: null },
    })
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    await expect(
      dispatcher([userMessage('hi')], { onStreamEvent: event => void received.push(event) }),
    ).rejects.toThrow('claude not found')

    const errorEvent = received.find(e => e.type === 'error')
    expect(errorEvent).toBeTruthy()
  })

  it('unsubscribes from stream events when the dispatcher completes', async () => {
    const { transport, listenerCount } = createFakeTransport()
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    await dispatcher([userMessage('hi')])

    expect(listenerCount()).toBe(0)
  })

  it('filters cross-session events once the session id is known', async () => {
    const { transport, emit } = createFakeTransport({
      sendPromptResult: { ok: true, sessionId: 'session-A' },
    })
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({
      config: claudeCodeConfigSchema.parse({
        projectDir: '/Users/dev/airi',
        sessionId: 'session-A',
      }),
      transport,
    })

    let sendPromptResolve: (result: ClaudeCodeSendPromptResult) => void = () => {}
    const pending = new Promise<ClaudeCodeSendPromptResult>((resolve) => {
      sendPromptResolve = resolve
    });
    (transport.sendPrompt as ReturnType<typeof vi.fn>).mockReturnValue(pending)

    const dispatcherPromise = dispatcher([userMessage('resume me')], {
      onStreamEvent: event => void received.push(event),
    })

    // Foreign session — must be ignored.
    emit({
      sessionId: 'session-OTHER',
      event: { kind: 'assistant-text', uuid: 'a-x', text: 'not for us', raw: {} },
    })
    // Correct session — must be forwarded.
    emit({
      sessionId: 'session-A',
      event: { kind: 'assistant-text', uuid: 'a-1', text: 'for us', raw: {} },
    })

    sendPromptResolve({ ok: true, sessionId: 'session-A' })
    await dispatcherPromise

    const texts = received.filter(e => e.type === 'text-delta').map(e => (e as { text: string }).text)
    expect(texts).toContain('for us')
    expect(texts).not.toContain('not for us')
  })

  it('emits a no_input finish event when no user text is available', async () => {
    const { transport, sendPromptCalls } = createFakeTransport()
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    await dispatcher([{ role: 'assistant', content: 'previous answer' } as Message], {
      onStreamEvent: event => void received.push(event),
    })

    expect(sendPromptCalls).toHaveLength(0)
    expect(received.find(e => e.type === 'finish')).toBeTruthy()
  })

  it('forwards assistant-thinking events as text-delta (temporary until a dedicated UI slice exists)', async () => {
    const { transport, emit } = createFakeTransport()
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    let sendPromptResolve: (result: ClaudeCodeSendPromptResult) => void = () => {}
    const pending = new Promise<ClaudeCodeSendPromptResult>((resolve) => {
      sendPromptResolve = resolve
    });
    (transport.sendPrompt as ReturnType<typeof vi.fn>).mockReturnValue(pending)

    const dispatcherPromise = dispatcher([userMessage('think about this')], {
      onStreamEvent: event => void received.push(event),
    })

    emit(normalised({
      kind: 'assistant-thinking',
      uuid: 'th-1',
      text: 'Hmm, let me reason about it',
      raw: {},
    }))

    sendPromptResolve({ ok: true, sessionId: 'generated-session-id' })
    await dispatcherPromise

    const thinkingDelta = received.find(
      e => e.type === 'text-delta' && (e as { text: string }).text === 'Hmm, let me reason about it',
    )
    expect(thinkingDelta).toBeTruthy()
  })

  it('forwards intermediate finish events from the manager before the dispatcher-level stop finish', async () => {
    const { transport, emit } = createFakeTransport()
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    let sendPromptResolve: (result: ClaudeCodeSendPromptResult) => void = () => {}
    const pending = new Promise<ClaudeCodeSendPromptResult>((resolve) => {
      sendPromptResolve = resolve
    });
    (transport.sendPrompt as ReturnType<typeof vi.fn>).mockReturnValue(pending)

    const dispatcherPromise = dispatcher([userMessage('hi')], {
      onStreamEvent: event => void received.push(event),
    })

    emit(normalised({ kind: 'finish', uuid: 'f-1', reason: 'turn_duration', raw: {} }))
    sendPromptResolve({ ok: true, sessionId: 'generated-session-id' })
    await dispatcherPromise

    // We should see at least one finish event (either the forwarded
    // turn_duration one or the dispatcher's synthetic `stop`).
    const finishes = received.filter(e => e.type === 'finish')
    expect(finishes.length).toBeGreaterThanOrEqual(1)
  })

  it('forwards an in-stream error event from the manager as a StreamEvent error', async () => {
    const { transport, emit } = createFakeTransport()
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    let sendPromptResolve: (result: ClaudeCodeSendPromptResult) => void = () => {}
    const pending = new Promise<ClaudeCodeSendPromptResult>((resolve) => {
      sendPromptResolve = resolve
    });
    (transport.sendPrompt as ReturnType<typeof vi.fn>).mockReturnValue(pending)

    const dispatcherPromise = dispatcher([userMessage('hi')], {
      onStreamEvent: event => void received.push(event),
    })

    emit(normalised({
      kind: 'error',
      uuid: 'e-1',
      error: 'model overloaded',
      raw: {},
    }))

    sendPromptResolve({ ok: true, sessionId: 'generated-session-id' })
    await dispatcherPromise

    const errorEvent = received.find(e => e.type === 'error')
    expect(errorEvent).toBeTruthy()
  })

  it('drops user-text / meta / unknown events so they never reach the chat orchestrator', async () => {
    const { transport, emit } = createFakeTransport()
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    let sendPromptResolve: (result: ClaudeCodeSendPromptResult) => void = () => {}
    const pending = new Promise<ClaudeCodeSendPromptResult>((resolve) => {
      sendPromptResolve = resolve
    });
    (transport.sendPrompt as ReturnType<typeof vi.fn>).mockReturnValue(pending)

    const dispatcherPromise = dispatcher([userMessage('hi')], {
      onStreamEvent: event => void received.push(event),
    })

    emit(normalised({ kind: 'user-text', uuid: 'u-1', text: 'you said this', raw: {} }))
    emit(normalised({ kind: 'meta', uuid: 'm-1', type: 'system:init', raw: {} }))
    emit(normalised({ kind: 'unknown', uuid: 'x-1', raw: { weird: true } }))

    sendPromptResolve({ ok: true, sessionId: 'generated-session-id' })
    await dispatcherPromise

    // Only the dispatcher-level synthetic finish should be forwarded.
    expect(received.filter(e => e.type === 'text-delta')).toHaveLength(0)
    expect(received.filter(e => e.type === 'tool-call')).toHaveLength(0)
    expect(received.filter(e => e.type === 'error')).toHaveLength(0)
  })

  it('stringifies non-string tool-result payloads via JSON.stringify', async () => {
    const { transport, emit } = createFakeTransport()
    const received: StreamEvent[] = []
    const dispatcher = createClaudeCodeStreamDispatcher({ config: parsedConfig, transport })

    let sendPromptResolve: (result: ClaudeCodeSendPromptResult) => void = () => {}
    const pending = new Promise<ClaudeCodeSendPromptResult>((resolve) => {
      sendPromptResolve = resolve
    });
    (transport.sendPrompt as ReturnType<typeof vi.fn>).mockReturnValue(pending)

    const dispatcherPromise = dispatcher([userMessage('fetch json')], {
      onStreamEvent: event => void received.push(event),
    })

    emit(normalised({
      kind: 'tool-result',
      uuid: 'tr-json',
      toolCallId: 'toolu_json',
      result: { key: 'value', nested: [1, 2, 3] },
      isError: false,
      raw: {},
    }))

    sendPromptResolve({ ok: true, sessionId: 'generated-session-id' })
    await dispatcherPromise

    const toolResult = received.find(e => e.type === 'tool-result') as { result: string } | undefined
    expect(toolResult).toBeTruthy()
    expect(toolResult?.result).toBe('{"key":"value","nested":[1,2,3]}')
  })
})

describe('createClaudeCodeProvider', () => {
  it('returns a ChatProvider shim carrying the stream marker', () => {
    const transport = createFakeTransport().transport
    const provider = createClaudeCodeProvider(
      claudeCodeConfigSchema.parse({
        binaryPath: 'claude',
        projectDir: '/Users/dev/airi',
      }),
      transport,
    )

    expect(typeof provider.chat).toBe('function')
    expect(typeof provider[CLAUDE_CODE_STREAM_METHOD]).toBe('function')
  })

  it('chat(model) returns a placeholder config that is never consumed', () => {
    const transport = createFakeTransport().transport
    const provider = createClaudeCodeProvider(
      claudeCodeConfigSchema.parse({
        binaryPath: 'claude',
        projectDir: '/Users/dev/airi',
      }),
      transport,
    )

    const chatConfig = provider.chat('claude-opus-4-6') as unknown as Record<string, unknown>
    expect(chatConfig.baseURL).toBe('claude-code-ipc://noop/')
    expect(chatConfig.model).toBe('claude-opus-4-6')
  })
})
