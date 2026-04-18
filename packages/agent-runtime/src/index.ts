// Public API — types, factories, and schemas only.
// Internal implementation modules are NOT re-exported here.

export type { ResetController } from './abort'

export { combineAbortSignalsManually, createResetController, linkAbortSignals } from './abort'
export type {
  ApprovalDecision,
  ApprovalRequest,
  CreateInteractiveApprovalGateOptions,
  InteractiveApprovalGate,
} from './approval'
export { createInteractiveApprovalGate } from './approval'
export type { AgentEventBus, EventListener } from './event-bus'
export { createAgentEventBus } from './event-bus'
export { createAgentHarness } from './harness'
export type { CreateAgentHarnessOptions } from './harness'

export type { RunAttemptDeps } from './run-attempt'
export { runAttempt } from './run-attempt'

export { agentEventSchema, runAttemptParamsSchema } from './schemas'
export type { AllowList, SensitivityResult } from './sensitivity'
export { evaluateSensitivity } from './sensitivity'
export type { HandleToolCallParams, ToolCallResult } from './tool-loop'
export { handleToolCall } from './tool-loop'
export type {
  AgentEvent,
  AgentHarness,
  AgentMessage,
  AgentPlan,
  AgentPrompt,
  AgentTurn,
  ApprovalGate,
  AttemptResult,
  DriverEvent,
  HarnessSupportContext,
  ModelDriver,
  PartialReply,
  RunAttemptParams,
  StopReason,
  SystemRunPlan,
  ToolDefinition,
  ToolInvoker,
} from './types'
