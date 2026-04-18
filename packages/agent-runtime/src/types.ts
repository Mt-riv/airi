export interface ToolCallRequest {
  callId: string
  toolName: string
  input: unknown
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolName?: string
  toolCalls?: ToolCallRequest[]
}

export interface AgentTurn {
  messages: AgentMessage[]
  tools: ToolDefinition[]
  systemPrompt?: string
}

export interface AgentPrompt {
  system?: string
  turns: AgentTurn[]
}

export type PartialReply
  = | { kind: 'text-delta', text: string }
    | { kind: 'thinking-delta', text: string }
    | { kind: 'image', url: string }

export type AgentEvent
  = | { kind: 'plan', plan: AgentPlan }
    | { kind: 'tool-call-requested', callId: string, toolName: string, input: unknown }
    | { kind: 'tool-call-approved', callId: string }
    | { kind: 'tool-call-rejected', callId: string, reason: string }
    | { kind: 'tool-call-completed', callId: string, output: unknown, durationMs: number }
    | { kind: 'approval-required', approvalId: string, plan: SystemRunPlan }
    | { kind: 'turn-finished', stopReason: StopReason }

export type StopReason
  = | 'end_turn'
    | 'tool_use'
    | 'max_tool_calls'
    | 'no_output'
    | 'error'
    | 'aborted'

export interface ToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface AgentPlan {
  id: string
  goal: string
  steps?: string[]
}

export interface SystemRunPlan {
  id: string
  toolName: string
  input: unknown
  sensitivityReason?: string
}

export interface AttemptResult {
  stopReason: StopReason
  toolCalls: number
  tokensIn?: number
  tokensOut?: number
  elapsedMs: number
}

export interface RunAttemptParams {
  turn: AgentTurn
  onPartialReply: (chunk: PartialReply) => void
  onAgentEvent: (event: AgentEvent) => void
  signal: AbortSignal
  /** Maximum tool calls per turn before forcing end_turn. Default: 20 */
  maxToolCalls?: number
}

export interface HarnessSupportContext {
  modelId?: string
  capabilities?: string[]
}

export type DriverEvent
  = | { kind: 'text-delta', text: string }
    | { kind: 'thinking-delta', text: string }
    | { kind: 'tool-call-requested', callId: string, toolName: string, input: unknown }
    | { kind: 'finish', stopReason: StopReason, tokensIn?: number, tokensOut?: number }
    | { kind: 'error', error: string }

export interface ModelDriver {
  stream: (
    messages: AgentMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ) => AsyncIterable<DriverEvent>
}

export interface ToolInvoker {
  invoke: (callId: string, toolName: string, input: unknown, signal: AbortSignal) => Promise<unknown>
  cancel: (callId: string) => void
}

export interface ApprovalGate {
  request: (plan: SystemRunPlan, signal: AbortSignal) => Promise<{ approved: boolean, reason?: string }>
}

export interface AgentHarness {
  readonly id: string
  supports: (ctx: HarnessSupportContext) => { supported: true, priority: number } | { supported: false }
  runAttempt: (params: RunAttemptParams) => Promise<AttemptResult>
  reset: (sessionId: string) => Promise<void>
}
