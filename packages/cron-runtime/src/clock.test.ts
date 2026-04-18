import { describe, expect, it } from 'vitest'

import { createFakeClock, SystemClock } from './clock'

describe('fakeClock', () => {
  it('fires callback when advance reaches deadline', () => {
    const clock = createFakeClock(0)
    const calls: number[] = []
    clock.setTimeout(() => calls.push(clock.currentTime()), 1000)
    clock.advance(999)
    expect(calls).toHaveLength(0)
    clock.advance(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(1000)
  })

  it('fires multiple callbacks in deadline order', () => {
    const clock = createFakeClock(0)
    const order: string[] = []
    clock.setTimeout(() => order.push('b'), 200)
    clock.setTimeout(() => order.push('a'), 100)
    clock.advance(200)
    expect(order).toEqual(['a', 'b'])
  })

  it('fires callbacks registered at same deadline in registration order', () => {
    const clock = createFakeClock(0)
    const order: string[] = []
    clock.setTimeout(() => order.push('first'), 100)
    clock.setTimeout(() => order.push('second'), 100)
    clock.advance(100)
    expect(order).toEqual(['first', 'second'])
  })

  it('does not fire cancelled callbacks', () => {
    const clock = createFakeClock(0)
    const calls: number[] = []
    const handle = clock.setTimeout(() => calls.push(1), 100)
    clock.clearTimeout(handle)
    clock.advance(200)
    expect(calls).toHaveLength(0)
  })
})

describe('systemClock', () => {
  it('now() returns a monotonically increasing value across two calls', () => {
    const t1 = SystemClock.now()
    const t2 = SystemClock.now()
    expect(t2).toBeGreaterThanOrEqual(t1)
  })

  it('now() returns a number close to Date.now()', () => {
    const before = Date.now()
    const t = SystemClock.now()
    const after = Date.now()
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(after)
  })
})
