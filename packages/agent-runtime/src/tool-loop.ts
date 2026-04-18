import type { AllowList } from './sensitivity'
import type { AgentEvent, ApprovalGate, SystemRunPlan, ToolInvoker } from './types'

import { errorMessageFrom } from '@moeru/std'

import { createAbortError, isAbortError } from './abort'
import { evaluateSensitivity } from './sensitivity'

export interface HandleToolCallParams {
  callId: string
  toolName: string
  input: unknown
  toolInvoker: ToolInvoker
  approvalGate: ApprovalGate
  allowList?: AllowList
  onAgentEvent: (event: AgentEvent) => void
  signal: AbortSignal
}

export interface ToolCallResult {
  output: unknown
  durationMs: number
}

export async function handleToolCall(params: HandleToolCallParams): Promise<ToolCallResult> {
  const { callId, toolName, input, toolInvoker, approvalGate, allowList, onAgentEvent, signal } = params

  onAgentEvent({ kind: 'tool-call-requested', callId, toolName, input })

  if (signal.aborted) {
    toolInvoker.cancel(callId)
    throw createAbortError('before tool approval')
  }

  const sensitivity = evaluateSensitivity(toolName, input, allowList)

  if (sensitivity.requiresApproval) {
    const plan: SystemRunPlan = {
      id: callId,
      toolName,
      input,
      sensitivityReason: sensitivity.reason,
    }

    onAgentEvent({ kind: 'approval-required', approvalId: callId, plan })

    const decision = await approvalGate.request(plan, signal)

    if (signal.aborted) {
      toolInvoker.cancel(callId)
      throw createAbortError('during approval wait')
    }

    if (!decision.approved) {
      const reason = decision.reason ?? 'rejected by user'
      onAgentEvent({ kind: 'tool-call-rejected', callId, reason })
      throw new Error(`Tool call rejected: ${reason}`)
    }

    onAgentEvent({ kind: 'tool-call-approved', callId })
  }

  if (signal.aborted) {
    toolInvoker.cancel(callId)
    throw createAbortError('before tool invoke')
  }

  const startMs = Date.now()
  let output: unknown
  try {
    output = await toolInvoker.invoke(callId, toolName, input, signal)
  }
  catch (err) {
    if (signal.aborted || isAbortError(err)) {
      toolInvoker.cancel(callId)
      throw err
    }
    throw new Error(`Tool '${toolName}' invocation failed: ${errorMessageFrom(err)}`)
  }

  const durationMs = Date.now() - startMs

  onAgentEvent({ kind: 'tool-call-completed', callId, output, durationMs })

  return { output, durationMs }
}
