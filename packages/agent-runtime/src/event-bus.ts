import { errorMessageFrom } from '@moeru/std'

export type EventListener<T> = (event: T) => void

export interface AgentEventBus<T> {
  on: (listener: EventListener<T>) => void
  off: (listener: EventListener<T>) => void
  emit: (event: T) => void
}

export function createAgentEventBus<T>(): AgentEventBus<T> {
  const listeners = new Set<EventListener<T>>()

  return {
    on(listener) {
      listeners.add(listener)
    },
    off(listener) {
      listeners.delete(listener)
    },
    emit(event) {
      for (const listener of listeners) {
        try {
          listener(event)
        }
        catch (err) {
          // NOTICE: Listener errors must never propagate; isolate each listener
          // so a misbehaving subscriber cannot break the emission loop.
          console.error('[agent-runtime] event-bus listener threw:', errorMessageFrom(err))
        }
      }
    },
  }
}
