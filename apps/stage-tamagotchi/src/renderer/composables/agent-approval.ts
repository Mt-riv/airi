import type { ApprovalDecision } from '@proj-airi/agent-runtime'
import type { PendingApprovalRecord } from '@proj-airi/stage-ui/stores/modules/agent-runtime'
import type { ComputedRef } from 'vue'

import { useAgentRuntimeStore } from '@proj-airi/stage-ui/stores/modules/agent-runtime'
import { computed } from 'vue'

export interface UseAgentApprovalReturn {
  current: ComputedRef<PendingApprovalRecord | null>
  count: ComputedRef<number>
  approve: (id: string) => void
  reject: (id: string, reason?: string) => void
  resolve: (id: string, decision: ApprovalDecision) => void
}

export function useAgentApproval(): UseAgentApprovalReturn {
  const store = useAgentRuntimeStore()

  const current = computed<PendingApprovalRecord | null>(() => store.pendingApprovals[0] ?? null)
  const count = computed<number>(() => store.pendingApprovals.length)

  function approve(id: string) {
    store.resolveApproval(id, { approved: true })
  }

  function reject(id: string, reason?: string) {
    store.resolveApproval(id, { approved: false, reason: reason ?? 'rejected by user' })
  }

  function resolve(id: string, decision: ApprovalDecision) {
    store.resolveApproval(id, decision)
  }

  return { current, count, approve, reject, resolve }
}
