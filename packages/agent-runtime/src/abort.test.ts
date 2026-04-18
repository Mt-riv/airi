import { describe, expect, it, vi } from 'vitest'

import { combineAbortSignalsManually, createResetController, linkAbortSignals } from './abort'

describe('linkAbortSignals', () => {
  it('returns a signal that aborts when the first input aborts', async () => {
    const c1 = new AbortController()
    const c2 = new AbortController()
    const combined = linkAbortSignals(c1.signal, c2.signal)

    expect(combined.aborted).toBe(false)
    c1.abort('reason-1')
    expect(combined.aborted).toBe(true)
  })

  it('returns a signal that aborts when the second input aborts', async () => {
    const c1 = new AbortController()
    const c2 = new AbortController()
    const combined = linkAbortSignals(c1.signal, c2.signal)

    c2.abort('reason-2')
    expect(combined.aborted).toBe(true)
  })

  it('returns an already-aborted signal if any input is already aborted', () => {
    const c1 = new AbortController()
    c1.abort('pre-aborted')
    const c2 = new AbortController()

    const combined = linkAbortSignals(c1.signal, c2.signal)
    expect(combined.aborted).toBe(true)
  })

  it('does not fire twice when both inputs abort', () => {
    const c1 = new AbortController()
    const c2 = new AbortController()
    const combined = linkAbortSignals(c1.signal, c2.signal)

    const listener = vi.fn()
    combined.addEventListener('abort', listener)

    c1.abort()
    c2.abort()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('returns a non-aborting signal when given zero inputs', () => {
    const combined = linkAbortSignals()
    expect(combined.aborted).toBe(false)
  })

  it('returns the same signal when given exactly one input', () => {
    const c = new AbortController()
    const result = linkAbortSignals(c.signal)
    expect(result).toBe(c.signal)
  })
})

// Tests for the manual fallback (exercises the code path that AbortSignal.any
// would otherwise bypass in modern Node environments).
describe('combineAbortSignalsManually', () => {
  it('aborts when the first signal aborts', () => {
    const c1 = new AbortController()
    const c2 = new AbortController()
    const combined = combineAbortSignalsManually(c1.signal, c2.signal)
    c1.abort('r1')
    expect(combined.aborted).toBe(true)
  })

  it('aborts when the second signal aborts', () => {
    const c1 = new AbortController()
    const c2 = new AbortController()
    const combined = combineAbortSignalsManually(c1.signal, c2.signal)
    c2.abort('r2')
    expect(combined.aborted).toBe(true)
  })

  it('returns an already-aborted signal when any input is pre-aborted', () => {
    const c1 = new AbortController()
    c1.abort('pre')
    const c2 = new AbortController()
    const combined = combineAbortSignalsManually(c1.signal, c2.signal)
    expect(combined.aborted).toBe(true)
  })

  it('does not fire abort listener twice', () => {
    const c1 = new AbortController()
    const c2 = new AbortController()
    const combined = combineAbortSignalsManually(c1.signal, c2.signal)
    const listener = vi.fn()
    combined.addEventListener('abort', listener)
    c1.abort()
    c2.abort()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('createResetController', () => {
  it('provides a signal that starts non-aborted', () => {
    const rc = createResetController()
    expect(rc.signal.aborted).toBe(false)
  })

  it('aborts the prior signal when reset() is called', () => {
    const rc = createResetController()
    // Capture the signal before reset so we can verify it was aborted
    const priorSignal = rc.signal
    rc.reset()
    expect(priorSignal.aborted).toBe(true)
  })

  it('provides a fresh non-aborted signal after reset()', () => {
    const rc = createResetController()
    const firstSignal = rc.signal

    rc.reset()

    const secondSignal = rc.signal
    expect(firstSignal.aborted).toBe(true)
    expect(secondSignal.aborted).toBe(false)
    expect(secondSignal).not.toBe(firstSignal)
  })

  it('can reset multiple times', () => {
    const rc = createResetController()

    rc.reset()
    rc.reset()
    rc.reset()

    expect(rc.signal.aborted).toBe(false)
  })
})
