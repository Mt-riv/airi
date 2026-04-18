import {
  array,
  literal,
  number,
  object,
  optional,
  picklist,
  record,
  string,
  union,
  unknown,
} from 'valibot'

// NOTICE: Function-typed fields (onPartialReply, onAgentEvent, signal) are
// excluded from runAttemptParamsSchema — they cannot be represented as static
// Valibot schemas.

const toolCallRequestSchema = object({
  callId: string(),
  toolName: string(),
  input: unknown(),
})

const agentMessageSchema = object({
  role: picklist(['user', 'assistant', 'tool']),
  content: string(),
  toolCallId: optional(string()),
  toolName: optional(string()),
  toolCalls: optional(array(toolCallRequestSchema)),
})

const toolDefinitionSchema = object({
  name: string(),
  description: optional(string()),
  inputSchema: record(string(), unknown()),
})

const agentTurnSchema = object({
  messages: array(agentMessageSchema),
  tools: array(toolDefinitionSchema),
  systemPrompt: optional(string()),
})

export const runAttemptParamsSchema = object({
  turn: agentTurnSchema,
  maxToolCalls: optional(number()),
})

const agentPlanSchema = object({
  id: string(),
  goal: string(),
  steps: optional(array(string())),
})

const systemRunPlanSchema = object({
  id: string(),
  toolName: string(),
  input: unknown(),
  sensitivityReason: optional(string()),
})

const stopReasonSchema = picklist([
  'end_turn',
  'tool_use',
  'max_tool_calls',
  'no_output',
  'error',
  'aborted',
])

export const agentEventSchema = union([
  object({ kind: literal('plan'), plan: agentPlanSchema }),
  object({ kind: literal('tool-call-requested'), callId: string(), toolName: string(), input: unknown() }),
  object({ kind: literal('tool-call-approved'), callId: string() }),
  object({ kind: literal('tool-call-rejected'), callId: string(), reason: string() }),
  object({ kind: literal('tool-call-completed'), callId: string(), output: unknown(), durationMs: number() }),
  object({ kind: literal('approval-required'), approvalId: string(), plan: systemRunPlanSchema }),
  object({ kind: literal('turn-finished'), stopReason: stopReasonSchema }),
])
