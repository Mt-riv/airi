import type { Clock } from './types'

export const SystemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface FakeTimer {
  deadline: number
  cb: () => void
  cancelled: boolean
}

export interface FakeClock extends Clock {
  advance: (ms: number) => void
  currentTime: () => number
}

export function createFakeClock(startMs = 0): FakeClock {
  let virtualNow = startMs
  const timers: FakeTimer[] = []

  // NOTICE: V8 `Array.prototype.sort` is stable (Node 12+), so timers with the
  // same deadline fire in registration order.
  const dueTimersSorted = (): FakeTimer[] =>
    timers
      .filter(t => !t.cancelled && t.deadline <= virtualNow)
      .sort((a, b) => a.deadline - b.deadline)

  return {
    now: () => virtualNow,

    setTimeout(cb, ms) {
      const timer: FakeTimer = { deadline: virtualNow + ms, cb, cancelled: false }
      timers.push(timer)
      return timer
    },

    clearTimeout(handle) {
      const t = handle as FakeTimer
      if (t != null) {
        t.cancelled = true
      }
    },

    advance(ms) {
      virtualNow += ms
      // Re-entrant: each callback may register new timers with earlier deadlines
      // that still fall within [virtualNow], so rescan after every fire.
      let next = dueTimersSorted()
      while (next.length > 0) {
        const t = next[0]
        if (!t.cancelled) {
          t.cancelled = true
          t.cb()
        }
        next = dueTimersSorted()
      }
    },

    currentTime: () => virtualNow,
  }
}
