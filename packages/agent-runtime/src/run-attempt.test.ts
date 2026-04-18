import type { AgentEvent, ApprovalGate, DriverEvent, ModelDriver, PartialReply, ToolInvoker } from './types'

import { describe, expect, it, vi } from 'vitest'

import { runAttempt } from './run-attempt'

// ---------------------------------------------------------------------------
// Test factories / helpers
// ---------------------------------------------------------------------------

function makeModelDriver(events: DriverEvent[]): ModelDriver {
  return {
    stream: vi.fn().mockImplementation(

      async function* () {
        for (const e of events) {
          yield e
        }
      },
    ),
  }
}

function makeToolInvoker(result: unknown = 'tool-result'): ToolInvoker {
  return {
    invoke: vi.fn().mockResolvedValue(result),
    cancel: vi.fn(),
  }
}

function makeApprovalGate(approved = true): ApprovalGate {
  return {
    request: vi.fn().mockResolvedValue({ approved }),
  }
}

function makeBaseTurn() {
  return {
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [],
  }
}

function makeParams(
  overrides: Partial<Parameters<typeof runAttempt>[0]> = {},
): Parameters<typeof runAttempt>[0] {
  return {
    turn: makeBaseTurn(),
    onPartialReply: vi.fn(),
    onAgentEvent: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

function makeDeps(
  driverEvents: DriverEvent[],
  overrides: Partial<Parameters<typeof runAttempt>[1]> = {},
): Parameters<typeof runAttempt>[1] {
  return {
    modelDriver: makeModelDriver(driverEvents),
    toolInvoker: makeToolInvoker(),
    approvalGate: makeApprovalGate(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAttempt', () => {
  it('happy path: delivers text-delta and emits turn-finished with end_turn', async () => {
    const onPartialReply = vi.fn()
    const onAgentEvent = vi.fn()

    const result = await runAttempt(
      makeParams({ onPartialReply, onAgentEvent }),
      makeDeps([
        { kind: 'text-delta', text: 'Hello, ' },
        { kind: 'text-delta', text: 'world!' },
        { kind: 'finish', stopReason: 'end_turn', tokensIn: 10, tokensOut: 5 },
      ]),
    )

    expect(result.stopReason).toBe('end_turn')
    expect(result.toolCalls).toBe(0)
    expect(result.tokensIn).toBe(10)
    expect(result.tokensOut).toBe(5)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)

    const partials: PartialReply[] = onPartialReply.mock.calls.map(c => c[0])
    expect(partials).toEqual([
      { kind: 'text-delta', text: 'Hello, ' },
      { kind: 'text-delta', text: 'world!' },
    ])

    const events: AgentEvent[] = onAgentEvent.mock.calls.map(c => c[0])
    expect(events.at(-1)).toMatchObject({ kind: 'turn-finished', stopReason: 'end_turn' })
  })

  it('mid-stream abort: stopReason is aborted and turn-finished is emitted', async () => {
    const controller = new AbortController()
    const onAgentEvent = vi.fn()

    // Abort mid-stream via a driver that yields one event then we abort
    const driver: ModelDriver = {
      stream: vi.fn().mockImplementation(
        async function* (_messages: unknown, _tools: unknown, _signal: AbortSignal) {
          yield { kind: 'text-delta' as const, text: 'partial' }
          // Simulate abort
          controller.abort('user-cancel')
          // Signal should now be aborted; runAttempt checks at each iteration
          yield { kind: 'text-delta' as const, text: 'should-not-reach' }
        },
      ),
    }

    const result = await runAttempt(
      makeParams({ signal: controller.signal, onAgentEvent }),
      {
        modelDriver: driver,
        toolInvoker: makeToolInvoker(),
        approvalGate: makeApprovalGate(),
      },
    )

    expect(result.stopReason).toBe('aborted')
    const events: AgentEvent[] = onAgentEvent.mock.calls.map(c => c[0])
    expect(events.at(-1)).toMatchObject({ kind: 'turn-finished', stopReason: 'aborted' })
  })

  it('tool call path: calls toolInvoker.invoke and counts the call', async () => {
    const invoker = makeToolInvoker('my-result')
    const onAgentEvent = vi.fn()

    // First stream: yields a tool call then finishes
    // Second stream (after tool result): yields end_turn
    let callCount = 0
    const driver: ModelDriver = {
      stream: vi.fn().mockImplementation(async function* () {
        callCount++
        if (callCount === 1) {
          yield { kind: 'tool-call-requested' as const, callId: 'tc-1', toolName: 'calculator.add', input: { a: 1 } }
          yield { kind: 'finish' as const, stopReason: 'tool_use' as const }
        }
        else {
          yield { kind: 'text-delta' as const, text: 'Result is 1.' }
          yield { kind: 'finish' as const, stopReason: 'end_turn' as const }
        }
      }),
    }

    const result = await runAttempt(
      makeParams({ onAgentEvent }),
      {
        modelDriver: driver,
        toolInvoker: invoker,
        approvalGate: makeApprovalGate(),
      },
    )

    expect(result.toolCalls).toBe(1)
    expect(result.stopReason).toBe('end_turn')
    expect(invoker.invoke).toHaveBeenCalledOnce()
    expect(invoker.invoke).toHaveBeenCalledWith('tc-1', 'calculator.add', { a: 1 }, expect.anything())
  })

  it('model error propagates: turn-finished with error stopReason and rethrows', async () => {
    const onAgentEvent = vi.fn()

    await expect(
      runAttempt(
        makeParams({ onAgentEvent }),
        makeDeps([
          { kind: 'text-delta', text: 'about to fail' },
          { kind: 'error', error: 'model overloaded' },
        ]),
      ),
    ).rejects.toThrow('model overloaded')

    const events: AgentEvent[] = onAgentEvent.mock.calls.map(c => c[0])
    expect(events.at(-1)).toMatchObject({ kind: 'turn-finished', stopReason: 'error' })
  })

  it('max-tool-calls guard: stops at the configured limit', async () => {
    const invoker = makeToolInvoker('ok')
    const onAgentEvent = vi.fn()

    let streamNum = 0
    const driver: ModelDriver = {
      stream: vi.fn().mockImplementation(async function* () {
        streamNum++
        // Always request a tool call (infinite loop without the guard)
        yield { kind: 'tool-call-requested' as const, callId: `tc-${streamNum}`, toolName: 'calculator.add', input: {} }
        yield { kind: 'finish' as const, stopReason: 'tool_use' as const }
      }),
    }

    const result = await runAttempt(
      makeParams({ onAgentEvent, maxToolCalls: 3 }),
      {
        modelDriver: driver,
        toolInvoker: invoker,
        approvalGate: makeApprovalGate(),
      },
    )

    expect(result.stopReason).toBe('max_tool_calls')
    expect(result.toolCalls).toBeLessThanOrEqual(3)
    const turnFinished = onAgentEvent.mock.calls.map(c => c[0] as AgentEvent).find(e => e.kind === 'turn-finished')
    expect(turnFinished).toMatchObject({ kind: 'turn-finished', stopReason: 'max_tool_calls' })
  })

  it('no_output finish: stopReason is no_output when model yields nothing', async () => {
    const onAgentEvent = vi.fn()

    const result = await runAttempt(
      makeParams({ onAgentEvent }),
      makeDeps([
        // Finish with end_turn but no text or tool calls
        { kind: 'finish', stopReason: 'end_turn' },
      ]),
    )

    expect(result.stopReason).toBe('no_output')
    const events: AgentEvent[] = onAgentEvent.mock.calls.map(c => c[0])
    expect(events.at(-1)).toMatchObject({ kind: 'turn-finished', stopReason: 'no_output' })
  })

  it('thinking-delta is forwarded to onPartialReply', async () => {
    const onPartialReply = vi.fn()

    await runAttempt(
      makeParams({ onPartialReply }),
      makeDeps([
        { kind: 'thinking-delta', text: 'hmm...' },
        { kind: 'finish', stopReason: 'end_turn' },
      ]),
    )

    const partials: PartialReply[] = onPartialReply.mock.calls.map(c => c[0])
    expect(partials[0]).toEqual({ kind: 'thinking-delta', text: 'hmm...' })
  })
})
