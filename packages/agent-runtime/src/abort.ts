export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

export function createAbortError(stage: string): DOMException {
  return new DOMException(`Aborted: ${stage}`, 'AbortError')
}

export function combineAbortSignalsManually(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()

  function onAbort(this: AbortSignal) {
    if (!controller.signal.aborted) {
      controller.abort(this.reason)
    }
  }

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  controller.signal.addEventListener('abort', () => {
    for (const signal of signals) {
      signal.removeEventListener('abort', onAbort)
    }
  }, { once: true })

  return controller.signal
}

// NOTICE: AbortSignal.any (Node ≥ 20.3 / modern browsers) manages listener
// cleanup internally. The manual fallback leaks a listener per input signal
// until the combined signal aborts — acceptable for short-lived per-turn use.
export function linkAbortSignals(...signals: AbortSignal[]): AbortSignal {
  if (signals.length === 0) {
    return new AbortController().signal
  }
  if (signals.length === 1) {
    return signals[0]
  }

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals)
  }

  return combineAbortSignalsManually(...signals)
}

export interface ResetController {
  readonly signal: AbortSignal
  reset: () => void
}

export function createResetController(): ResetController {
  let controller = new AbortController()

  return {
    get signal() {
      return controller.signal
    },
    reset() {
      controller.abort('session-reset')
      controller = new AbortController()
    },
  }
}
