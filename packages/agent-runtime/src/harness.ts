import type { AllowList } from './sensitivity'
import type { AgentHarness, ApprovalGate, AttemptResult, HarnessSupportContext, ModelDriver, RunAttemptParams, ToolInvoker } from './types'

import { runAttempt } from './run-attempt'

let harnessCounter = 0

export interface CreateAgentHarnessOptions {
  modelDriver: ModelDriver
  toolInvoker: ToolInvoker
  approvalGate: ApprovalGate
  allowList?: AllowList
  /** Optional stable ID; auto-generated if omitted. */
  id?: string
}

export function createAgentHarness(options: CreateAgentHarnessOptions): AgentHarness {
  const id = options.id ?? `harness-${++harnessCounter}`

  return {
    get id() {
      return id
    },

    supports(_ctx: HarnessSupportContext) {
      return { supported: true as const, priority: 100 }
    },

    async runAttempt(params: RunAttemptParams): Promise<AttemptResult> {
      return runAttempt(params, {
        modelDriver: options.modelDriver,
        toolInvoker: options.toolInvoker,
        approvalGate: options.approvalGate,
        allowList: options.allowList,
      })
    },

    async reset(_sessionId: string): Promise<void> {},
  }
}
