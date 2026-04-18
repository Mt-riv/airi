import type { PendingApprovalRecord } from '@proj-airi/stage-ui/stores/modules/agent-runtime'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

const resolveApprovalSpy = vi.fn()
const mockStoreState = reactive<{ pendingApprovals: PendingApprovalRecord[] }>({ pendingApprovals: [] })

vi.mock('@proj-airi/stage-ui/stores/modules/agent-runtime', () => ({
  useAgentRuntimeStore: () => ({
    pendingApprovals: mockStoreState.pendingApprovals,
    resolveApproval: resolveApprovalSpy,
  }),
}))

function makeRecord(overrides: Partial<PendingApprovalRecord> = {}): PendingApprovalRecord {
  return {
    id: 'call-1',
    turnId: 'turn-1',
    plan: {
      id: 'call-1',
      toolName: 'network.fetch',
      input: { url: 'https://example.com' },
      sensitivityReason: 'network tool',
    },
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('useAgentApproval', () => {
  beforeEach(() => {
    mockStoreState.pendingApprovals = []
    resolveApprovalSpy.mockReset()
  })

  it('exposes the oldest pending approval as current and total count', async () => {
    mockStoreState.pendingApprovals = [
      makeRecord({ id: 'a', plan: { id: 'a', toolName: 'shell', input: {} } }),
      makeRecord({ id: 'b', plan: { id: 'b', toolName: 'network.fetch', input: {} } }),
    ]

    const { useAgentApproval } = await import('./agent-approval')
    const { current, count } = useAgentApproval()

    expect(current.value?.id).toBe('a')
    expect(count.value).toBe(2)
  })

  it('approve() routes through the store with approved=true', async () => {
    const { useAgentApproval } = await import('./agent-approval')
    const { approve } = useAgentApproval()

    approve('call-1')

    expect(resolveApprovalSpy).toHaveBeenCalledWith('call-1', { approved: true })
  })

  it('reject() passes the reason and falls back to a generic one when empty', async () => {
    const { useAgentApproval } = await import('./agent-approval')
    const { reject } = useAgentApproval()

    reject('call-1', 'dangerous path')
    reject('call-2')

    expect(resolveApprovalSpy).toHaveBeenNthCalledWith(1, 'call-1', { approved: false, reason: 'dangerous path' })
    expect(resolveApprovalSpy).toHaveBeenNthCalledWith(2, 'call-2', { approved: false, reason: 'rejected by user' })
  })
})
