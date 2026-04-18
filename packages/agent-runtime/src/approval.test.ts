import type { SystemRunPlan } from './types'

import { describe, expect, it, vi } from 'vitest'

import { createInteractiveApprovalGate } from './approval'

function makePlan(overrides: Partial<SystemRunPlan> = {}): SystemRunPlan {
  return {
    id: 'call-1',
    toolName: 'network.fetch',
    input: { url: 'https://example.com' },
    sensitivityReason: 'network tool',
    ...overrides,
  }
}

describe('createInteractiveApprovalGate', () => {
  it('emits a pending request and resolves when the caller approves', async () => {
    const emit = vi.fn()
    const gate = createInteractiveApprovalGate({ emit })
    const plan = makePlan()

    const promise = gate.request(plan, new AbortController().signal)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]![0]).toMatchObject({ id: plan.id, plan })
    expect(gate.pending.has(plan.id)).toBe(true)

    gate.resolve(plan.id, { approved: true })

    await expect(promise).resolves.toEqual({ approved: true })
    expect(gate.pending.has(plan.id)).toBe(false)
  })

  it('resolves with approved=false and the reason when rejected', async () => {
    const gate = createInteractiveApprovalGate()
    const plan = makePlan()
    const promise = gate.request(plan, new AbortController().signal)

    gate.resolve(plan.id, { approved: false, reason: 'user rejected' })

    await expect(promise).resolves.toEqual({ approved: false, reason: 'user rejected' })
    expect(gate.pending.size).toBe(0)
  })

  it('auto-rejects with a timeout reason when timeoutMs elapses', async () => {
    vi.useFakeTimers()
    try {
      const gate = createInteractiveApprovalGate({ timeoutMs: 50 })
      const plan = makePlan()
      const promise = gate.request(plan, new AbortController().signal)

      vi.advanceTimersByTime(50)

      await expect(promise).resolves.toEqual({ approved: false, reason: 'approval timed out' })
      expect(gate.pending.size).toBe(0)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('rejects with an AbortError when the signal aborts mid-wait', async () => {
    const gate = createInteractiveApprovalGate()
    const controller = new AbortController()
    const plan = makePlan()
    const promise = gate.request(plan, controller.signal)

    controller.abort()

    await expect(promise).rejects.toThrow(/abort/i)
    expect(gate.pending.size).toBe(0)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const gate = createInteractiveApprovalGate()
    const controller = new AbortController()
    controller.abort()

    await expect(gate.request(makePlan(), controller.signal)).rejects.toThrow(/abort/i)
    expect(gate.pending.size).toBe(0)
  })

  it('ignores resolve calls for unknown ids and double-resolve attempts', async () => {
    const gate = createInteractiveApprovalGate()
    const plan = makePlan()
    const promise = gate.request(plan, new AbortController().signal)

    gate.resolve('unknown', { approved: true })
    expect(gate.pending.has(plan.id)).toBe(true)

    gate.resolve(plan.id, { approved: true })
    gate.resolve(plan.id, { approved: false, reason: 'late' })

    await expect(promise).resolves.toEqual({ approved: true })
    expect(gate.pending.size).toBe(0)
  })
})
