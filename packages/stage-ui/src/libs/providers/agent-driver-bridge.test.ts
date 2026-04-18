import type { DriverEvent, ToolDefinition } from '@proj-airi/agent-runtime'
import type { ChatProvider } from '@xsai-ext/providers/utils'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createXsaiModelDriver } from './agent-driver-bridge'

type StreamTextEvent
  = | { type: 'text-delta', text: string }
    | { type: 'reasoning-delta', text: string }
    | { type: 'tool-call', toolCallId: string, toolName: string, args: unknown }
    | { type: 'finish', finishReason?: string, usage?: { prompt_tokens?: number, completion_tokens?: number } }
    | { type: 'error', error: unknown }

interface FakeStreamPlan {
  events: StreamTextEvent[]
  steps?: Array<{ finishReason?: string, usage?: { prompt_tokens?: number, completion_tokens?: number } }>
  rejectSteps?: unknown
}

const streamTextMock = vi.fn()
vi.mock('@xsai/stream-text', () => ({
  streamText: (args: unknown) => streamTextMock(args),
}))
vi.mock('@xsai/shared-chat', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@xsai/shared-chat')
  return {
    ...actual,
    stepCountAtLeast: vi.fn(() => () => true),
  }
})

function configureStream(plan: FakeStreamPlan) {
  streamTextMock.mockImplementation(({ onEvent }: { onEvent: (event: StreamTextEvent) => void }) => {
    for (const event of plan.events) onEvent(event)

    const steps = plan.rejectSteps != null
      ? Promise.reject(plan.rejectSteps)
      : Promise.resolve(plan.steps ?? [])

    return {
      steps,
      messages: Promise.resolve([]),
      usage: Promise.resolve({}),
      totalUsage: Promise.resolve({}),
    }
  })
}

function makeChatProvider(): ChatProvider {
  return {
    chat: vi.fn(() => ({ apiKey: 'test-key', baseURL: 'https://example.test/v1/' })),
  } as unknown as ChatProvider
}

async function collect(iterable: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
  const events: DriverEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('createXsaiModelDriver', () => {
  beforeEach(() => {
    streamTextMock.mockReset()
  })

  it('yields text-delta events and the xsai-provided finish event', async () => {
    configureStream({
      events: [
        { type: 'text-delta', text: 'hello ' },
        { type: 'text-delta', text: 'world' },
        { type: 'finish', finishReason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 3 } },
      ],
      steps: [{ finishReason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 3 } }],
    })

    const driver = createXsaiModelDriver({ model: 'gpt-fake', chatProvider: makeChatProvider() })
    const events = await collect(driver.stream([{ role: 'user', content: 'hi' }], [], new AbortController().signal))

    expect(events).toEqual([
      { kind: 'text-delta', text: 'hello ' },
      { kind: 'text-delta', text: 'world' },
      { kind: 'finish', stopReason: 'end_turn', tokensIn: 7, tokensOut: 3 },
    ])
  })

  it('emits a tool-call-requested event and synthesizes a finish event when xsai omits it', async () => {
    configureStream({
      events: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'search',
          args: JSON.stringify({ query: 'cats' }),
        },
      ],
      steps: [{ finishReason: 'tool-calls', usage: { prompt_tokens: 5, completion_tokens: 2 } }],
    })

    const tools: ToolDefinition[] = [{
      name: 'search',
      description: 'Search the web',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }]
    const driver = createXsaiModelDriver({ model: 'gpt-fake', chatProvider: makeChatProvider() })
    const events = await collect(driver.stream([{ role: 'user', content: 'find cats' }], tools, new AbortController().signal))

    expect(events).toEqual([
      {
        kind: 'tool-call-requested',
        callId: 'call-1',
        toolName: 'search',
        input: { query: 'cats' },
      },
      { kind: 'finish', stopReason: 'tool_use', tokensIn: 5, tokensOut: 2 },
    ])
  })

  it('emits an error event when the step promise rejects', async () => {
    configureStream({
      events: [{ type: 'text-delta', text: 'partial' }],
      rejectSteps: new Error('boom'),
    })

    const driver = createXsaiModelDriver({ model: 'gpt-fake', chatProvider: makeChatProvider() })
    const events = await collect(driver.stream([{ role: 'user', content: 'hi' }], [], new AbortController().signal))

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ kind: 'text-delta', text: 'partial' })
    expect(events[1]).toEqual({ kind: 'error', error: 'boom' })
  })

  it('passes systemPrompt as the leading system message to xsai', async () => {
    configureStream({
      events: [{ type: 'finish', finishReason: 'stop' }],
      steps: [{ finishReason: 'stop' }],
    })

    const driver = createXsaiModelDriver({
      model: 'gpt-fake',
      chatProvider: makeChatProvider(),
      systemPrompt: 'you are airi',
    })
    await collect(driver.stream([{ role: 'user', content: 'hi' }], [], new AbortController().signal))

    expect(streamTextMock).toHaveBeenCalledTimes(1)
    const call = streamTextMock.mock.calls[0]![0] as { messages: Array<{ role: string, content: string }> }
    expect(call.messages[0]).toEqual({ role: 'system', content: 'you are airi' })
    expect(call.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })
})
