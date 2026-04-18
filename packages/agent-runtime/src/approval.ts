import type { ApprovalGate, SystemRunPlan } from './types'

import { createAbortError } from './abort'

export interface ApprovalRequest {
  id: string
  plan: SystemRunPlan
}

export interface ApprovalDecision {
  approved: boolean
  reason?: string
}

export interface InteractiveApprovalGate extends ApprovalGate {
  resolve: (id: string, decision: ApprovalDecision) => void
  readonly pending: ReadonlyMap<string, ApprovalRequest>
}

export interface CreateInteractiveApprovalGateOptions {
  /** Called once per new approval request. Throws inside emit are swallowed. */
  emit?: (request: ApprovalRequest) => void
  /** Called when a request settles (resolved, timed out, or aborted). */
  onSettled?: (id: string, decision: ApprovalDecision | { aborted: true }) => void
  /** Auto-reject after this many ms with reason='approval timed out'. Omit to disable. */
  timeoutMs?: number
}

interface PendingEntry {
  request: ApprovalRequest
  resolve: (decision: ApprovalDecision) => void
}

export function createInteractiveApprovalGate(
  options: CreateInteractiveApprovalGateOptions = {},
): InteractiveApprovalGate {
  const pending = new Map<string, PendingEntry>()
  // NOTICE: pendingView is a read-only projection of the internal pending map
  // for consumers that only need visibility into `{ id, plan }`. Keeping it
  // separate avoids leaking the `resolve` closure across the package boundary.
  const pendingView = new Map<string, ApprovalRequest>()

  function request(plan: SystemRunPlan, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted)
      return Promise.reject(createAbortError('approval wait'))

    const approvalRequest: ApprovalRequest = { id: plan.id, plan }

    return new Promise<ApprovalDecision>((resolveFn, rejectFn) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => finalizeAbort()

      function finalize(decision: ApprovalDecision) {
        if (settled)
          return
        settled = true
        pending.delete(plan.id)
        pendingView.delete(plan.id)
        if (timer !== undefined)
          clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        try {
          options.onSettled?.(plan.id, decision)
        }
        catch {
          // NOTICE: ignore observer failures so one bad listener cannot
          // poison the gate for other callers.
        }
        resolveFn(decision)
      }

      function finalizeAbort() {
        if (settled)
          return
        settled = true
        pending.delete(plan.id)
        pendingView.delete(plan.id)
        if (timer !== undefined)
          clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        try {
          options.onSettled?.(plan.id, { aborted: true })
        }
        catch {
          // see finalize()
        }
        rejectFn(createAbortError('approval wait'))
      }

      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          finalize({ approved: false, reason: 'approval timed out' })
        }, options.timeoutMs)
      }

      signal.addEventListener('abort', onAbort, { once: true })

      pending.set(plan.id, { request: approvalRequest, resolve: finalize })
      pendingView.set(plan.id, approvalRequest)

      try {
        options.emit?.(approvalRequest)
      }
      catch {
        // NOTICE: emit is a notify-only sink; swallowing errors keeps
        // request() contract-stable even if the renderer listener throws.
      }
    })
  }

  function resolve(id: string, decision: ApprovalDecision): void {
    const entry = pending.get(id)
    if (!entry)
      return
    entry.resolve(decision)
  }

  return {
    request,
    resolve,
    pending: pendingView,
  }
}
