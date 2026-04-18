import { safeParse } from 'valibot'
import { describe, expect, it } from 'vitest'

import { agentEventSchema, runAttemptParamsSchema } from './schemas'

// ---------------------------------------------------------------------------
// runAttemptParamsSchema
// ---------------------------------------------------------------------------

describe('runAttemptParamsSchema', () => {
  it('accepts a minimal valid RunAttemptParams (no maxToolCalls)', () => {
    const result = safeParse(runAttemptParamsSchema, {
      turn: {
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts RunAttemptParams with maxToolCalls', () => {
    const result = safeParse(runAttemptParamsSchema, {
      turn: {
        messages: [],
        tools: [{ name: 'my-tool', inputSchema: {} }],
        systemPrompt: 'You are helpful.',
      },
      maxToolCalls: 10,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing required turn field', () => {
    const result = safeParse(runAttemptParamsSchema, {})
    expect(result.success).toBe(false)
  })

  it('rejects invalid role in message', () => {
    const result = safeParse(runAttemptParamsSchema, {
      turn: {
        messages: [{ role: 'system', content: 'bad role' }],
        tools: [],
      },
    })
    expect(result.success).toBe(false)
  })

  it('accepts a message with optional toolCallId and toolName', () => {
    const result = safeParse(runAttemptParamsSchema, {
      turn: {
        messages: [{
          role: 'tool',
          content: 'result',
          toolCallId: 'call-123',
          toolName: 'my-tool',
        }],
        tools: [],
      },
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// agentEventSchema
// ---------------------------------------------------------------------------

describe('agentEventSchema', () => {
  it('accepts a turn-finished event', () => {
    const result = safeParse(agentEventSchema, {
      kind: 'turn-finished',
      stopReason: 'end_turn',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a tool-call-requested event', () => {
    const result = safeParse(agentEventSchema, {
      kind: 'tool-call-requested',
      callId: 'call-1',
      toolName: 'my-tool',
      input: { foo: 'bar' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a tool-call-completed event', () => {
    const result = safeParse(agentEventSchema, {
      kind: 'tool-call-completed',
      callId: 'call-2',
      output: { result: 42 },
      durationMs: 150,
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown discriminator kind', () => {
    const result = safeParse(agentEventSchema, {
      kind: 'unknown-event-type',
      callId: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a turn-finished event with invalid stopReason', () => {
    const result = safeParse(agentEventSchema, {
      kind: 'turn-finished',
      stopReason: 'totally-made-up',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a plan event with optional steps', () => {
    const result = safeParse(agentEventSchema, {
      kind: 'plan',
      plan: { id: 'p1', goal: 'do stuff', steps: ['step 1', 'step 2'] },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a tool-call-rejected event', () => {
    const result = safeParse(agentEventSchema, {
      kind: 'tool-call-rejected',
      callId: 'call-3',
      reason: 'user denied',
    })
    expect(result.success).toBe(true)
  })
})
