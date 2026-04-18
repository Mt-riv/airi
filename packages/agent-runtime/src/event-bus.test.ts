import { describe, expect, it, vi } from 'vitest'

import { createAgentEventBus } from './event-bus'

describe('createAgentEventBus', () => {
  it('delivers events to subscribed listeners', () => {
    const bus = createAgentEventBus<{ value: number }>()
    const received: number[] = []

    bus.on(event => received.push(event.value))
    bus.emit({ value: 1 })
    bus.emit({ value: 2 })

    expect(received).toEqual([1, 2])
  })

  it('does not deliver events to unsubscribed listeners', () => {
    const bus = createAgentEventBus<string>()
    const received: string[] = []

    const listener = (e: string) => received.push(e)
    bus.on(listener)
    bus.emit('a')
    bus.off(listener)
    bus.emit('b')

    expect(received).toEqual(['a'])
  })

  it('isolates listener exceptions — other listeners still receive the event', () => {
    const bus = createAgentEventBus<string>()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const received: string[] = []

    bus.on(() => {
      throw new Error('boom')
    })
    bus.on(e => received.push(e))

    bus.emit('hello')

    expect(received).toEqual(['hello'])
    expect(consoleSpy).toHaveBeenCalledOnce()
    consoleSpy.mockRestore()
  })

  it('supports multiple listeners independently', () => {
    const bus = createAgentEventBus<number>()
    const a: number[] = []
    const b: number[] = []

    bus.on(e => a.push(e))
    bus.on(e => b.push(e))
    bus.emit(42)

    expect(a).toEqual([42])
    expect(b).toEqual([42])
  })

  it('is a no-op to remove a listener that was never registered', () => {
    const bus = createAgentEventBus<string>()
    // Should not throw
    expect(() => bus.off(() => {})).not.toThrow()
  })
})
