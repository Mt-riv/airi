import type { AgentEvent, ApprovalGate, SystemRunPlan, ToolInvoker } from './types'

import { describe, expect, it, vi } from 'vitest'

import { handleToolCall } from './tool-loop'

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makeToolInvoker(result: unknown = 'ok'): ToolInvoker {
  return {
    invoke: vi.fn().mockResolvedValue(result),
    cancel: vi.fn(),
  }
}

function makeApprovalGate(approved: boolean, reason?: string): ApprovalGate {
  return {
    request: vi.fn().mockResolvedValue({ approved, reason }),
  }
}

function makeParams(overrides: Partial<Parameters<typeof handleToolCall>[0]> = {}) {
  return {
    callId: 'call-1',
    toolName: 'calculator.add',
    input: { a: 1, b: 2 },
    toolInvoker: makeToolInvoker(),
    approvalGate: makeApprovalGate(true),
    onAgentEvent: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleToolCall', () => {
  it('auto-invokes a non-sensitive tool without requesting approval', async () => {
    const invoker = makeToolInvoker('result-value')
    const gate = makeApprovalGate(true)
    const onEvent = vi.fn()

    const result = await handleToolCall({
      callId: 'c1',
      toolName: 'calculator.add',
      input: { a: 1 },
      toolInvoker: invoker,
      approvalGate: gate,
      onAgentEvent: onEvent,
      signal: new AbortController().signal,
    })

    expect(invoker.invoke).toHaveBeenCalledOnce()
    expect(gate.request).not.toHaveBeenCalled()
    expect(result.output).toBe('result-value')

    const events: AgentEvent[] = onEvent.mock.calls.map(c => c[0])
    expect(events.some(e => e.kind === 'tool-call-requested')).toBe(true)
    expect(events.some(e => e.kind === 'tool-call-completed')).toBe(true)
    expect(events.some(e => e.kind === 'approval-required')).toBe(false)
  })

  it('emits approval-required and invokes when approved for sensitive tool', async () => {
    const invoker = makeToolInvoker('shell-output')
    const gate = makeApprovalGate(true)
    const onEvent = vi.fn()

    await handleToolCall({
      callId: 'c2',
      toolName: 'shell.exec',
      input: { command: 'ls' },
      toolInvoker: invoker,
      approvalGate: gate,
      onAgentEvent: onEvent,
      signal: new AbortController().signal,
    })

    expect(gate.request).toHaveBeenCalledOnce()
    expect(invoker.invoke).toHaveBeenCalledOnce()

    const events: AgentEvent[] = onEvent.mock.calls.map(c => c[0])
    const kinds = events.map(e => e.kind)
    expect(kinds).toContain('approval-required')
    expect(kinds).toContain('tool-call-approved')
    expect(kinds).toContain('tool-call-completed')
  })

  it('emits tool-call-rejected and throws when approval is denied', async () => {
    const invoker = makeToolInvoker()
    const gate = makeApprovalGate(false, 'user denied')
    const onEvent = vi.fn()

    await expect(handleToolCall({
      callId: 'c3',
      toolName: 'shell.exec',
      input: { command: 'rm -rf /' },
      toolInvoker: invoker,
      approvalGate: gate,
      onAgentEvent: onEvent,
      signal: new AbortController().signal,
    })).rejects.toThrow('rejected')

    const events: AgentEvent[] = onEvent.mock.calls.map(c => c[0])
    const rejectedEvent = events.find(e => e.kind === 'tool-call-rejected')
    expect(rejectedEvent).toBeDefined()
    expect(rejectedEvent).toMatchObject({ kind: 'tool-call-rejected', callId: 'c3', reason: 'user denied' })
    expect(invoker.invoke).not.toHaveBeenCalled()
  })

  it('throws AbortError and calls cancel when signal aborts before invocation', async () => {
    const controller = new AbortController()
    controller.abort()

    const invoker = makeToolInvoker()
    const gate = makeApprovalGate(true)
    const onEvent = vi.fn()

    await expect(handleToolCall({
      callId: 'c4',
      toolName: 'calculator.add',
      input: {},
      toolInvoker: invoker,
      approvalGate: gate,
      onAgentEvent: onEvent,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(invoker.cancel).toHaveBeenCalledWith('c4')
    expect(invoker.invoke).not.toHaveBeenCalled()
  })

  it('propagates invocation errors as wrapped errors', async () => {
    const invoker: ToolInvoker = {
      invoke: vi.fn().mockRejectedValue(new Error('disk full')),
      cancel: vi.fn(),
    }
    const gate = makeApprovalGate(true)

    await expect(handleToolCall(makeParams({ toolName: 'calculator.add', toolInvoker: invoker, approvalGate: gate }))).rejects.toThrow('disk full')
  })

  it('calls toolInvoker.cancel and throws when signal aborts during approval wait', async () => {
    const controller = new AbortController()

    // Gate resolves only after signal aborts
    const gate: ApprovalGate = {
      request: vi.fn().mockImplementation((_plan: SystemRunPlan, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ approved: true }), { once: true })
          // Abort immediately to simulate timeout
          controller.abort('timeout')
        }),
      ),
    }

    const invoker = makeToolInvoker()
    const onEvent = vi.fn()

    await expect(handleToolCall({
      callId: 'c5',
      toolName: 'shell.exec',
      input: { command: 'sleep 100' },
      toolInvoker: invoker,
      approvalGate: gate,
      onAgentEvent: onEvent,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(invoker.cancel).toHaveBeenCalledWith('c5')
    expect(invoker.invoke).not.toHaveBeenCalled()
  })

  it('emits tool-call-completed with positive durationMs', async () => {
    const onEvent = vi.fn()
    await handleToolCall(makeParams({ onAgentEvent: onEvent }))

    const completed = onEvent.mock.calls.map(c => c[0] as AgentEvent).find(e => e.kind === 'tool-call-completed')
    expect(completed).toBeDefined()
    if (completed?.kind === 'tool-call-completed') {
      expect(completed.durationMs).toBeGreaterThanOrEqual(0)
    }
  })
})
