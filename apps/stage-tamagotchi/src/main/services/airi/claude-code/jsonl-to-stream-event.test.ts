import { describe, expect, it } from 'vitest'

import { normalizeClaudeCodeLine } from './jsonl-to-stream-event'

function line(payload: unknown): string {
  return JSON.stringify(payload)
}

describe('normalizeClaudeCodeLine', () => {
  it('returns an empty array for blank / whitespace input', () => {
    expect(normalizeClaudeCodeLine('')).toEqual([])
    expect(normalizeClaudeCodeLine('   \n  ')).toEqual([])
  })

  it('returns an unknown event for invalid JSON instead of throwing', () => {
    const result = normalizeClaudeCodeLine('{not-json')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ kind: 'unknown' })
  })

  it('normalises a user string message to a single user-text event', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'user',
      uuid: 'u-1',
      sessionId: 's-1',
      message: { role: 'user', content: 'hello world' },
    }))

    expect(result).toEqual([
      expect.objectContaining({
        kind: 'user-text',
        uuid: 'u-1',
        text: 'hello world',
      }),
    ])
  })

  it('normalises a user tool_result block to a tool-result event', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'user',
      uuid: 'u-2',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_xyz',
            content: '(Bash completed with no output)',
            is_error: false,
          },
        ],
      },
    }))

    expect(result).toEqual([
      expect.objectContaining({
        kind: 'tool-result',
        toolCallId: 'toolu_xyz',
        result: '(Bash completed with no output)',
        isError: false,
      }),
    ])
  })

  it('marks tool_result events as errors when is_error is true', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'user',
      uuid: 'u-3',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_err', content: 'boom', is_error: true },
        ],
      },
    }))

    expect(result[0]).toMatchObject({ kind: 'tool-result', isError: true })
  })

  it('normalises an assistant message with text + tool_use into multiple events in order', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'assistant',
      uuid: 'a-1',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Running a command.' },
          {
            type: 'tool_use',
            id: 'toolu_123',
            name: 'Bash',
            input: { command: 'ls', description: 'list files' },
          },
        ],
      },
    }))

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ kind: 'assistant-text', text: 'Running a command.' })
    expect(result[1]).toMatchObject({
      kind: 'tool-call',
      toolCallId: 'toolu_123',
      toolName: 'Bash',
      args: { command: 'ls', description: 'list files' },
    })
  })

  it('emits assistant-thinking events for extended thinking blocks', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'assistant',
      uuid: 'a-2',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think…', signature: 'sig' },
          { type: 'text', text: 'Answer.' },
        ],
      },
    }))

    expect(result[0]).toMatchObject({ kind: 'assistant-thinking', text: 'Let me think…' })
    expect(result[1]).toMatchObject({ kind: 'assistant-text', text: 'Answer.' })
  })

  it('maps system api_error events to error events', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'system',
      uuid: 's-1',
      subtype: 'api_error',
      error: { status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } },
    }))

    expect(result[0]).toMatchObject({
      kind: 'error',
      error: expect.stringContaining('Overloaded'),
    })
  })

  it('maps system turn_duration events to finish events', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'system',
      uuid: 's-2',
      subtype: 'turn_duration',
      durationMs: 123,
      messageCount: 4,
    }))

    expect(result[0]).toMatchObject({ kind: 'finish', reason: 'turn_duration' })
  })

  it('drops file-history-snapshot / attachment / permission-mode as meta events', () => {
    const metas = [
      { type: 'file-history-snapshot', messageId: 'm-1', snapshot: {} },
      { type: 'attachment', uuid: 'at-1', attachment: { type: 'deferred_tools_delta' } },
      { type: 'permission-mode', sessionId: 's-1', permissionMode: 'default' },
      { type: 'last-prompt', uuid: 'lp-1' },
      { type: 'queue-operation', uuid: 'qo-1' },
    ]

    for (const payload of metas) {
      const result = normalizeClaudeCodeLine(line(payload))
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ kind: 'meta' })
    }
  })

  it('normalises stream-dialect result events into finish events', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'result',
      uuid: 'r-1',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      result: 'Hi there friend',
      session_id: 'abc',
    }))

    expect(result[0]).toMatchObject({ kind: 'finish', reason: 'end_turn' })
  })

  it('normalises stream-dialect failed result events into error events', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'result',
      uuid: 'r-2',
      subtype: 'error_max_turns',
      is_error: true,
      result: 'turn limit reached',
    }))

    expect(result[0]).toMatchObject({ kind: 'error' })
  })

  it('flattens stream_event content_block_delta text_delta into assistant-text', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'stream_event',
      uuid: 'se-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    }))

    expect(result[0]).toMatchObject({ kind: 'assistant-text', text: 'Hello' })
  })

  it('falls through to unknown for unrecognised top-level types', () => {
    const result = normalizeClaudeCodeLine(line({
      type: 'brand_new_event_type_from_the_future',
      uuid: 'x-1',
    }))

    expect(result[0]).toMatchObject({ kind: 'unknown' })
  })

  it('parses multiple events from multiline input', () => {
    const multi
      = `${line({ type: 'user', uuid: 'u-10', message: { role: 'user', content: 'hi' } })}\n`
        + `${line({ type: 'assistant', uuid: 'a-10', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } })}\n`

    const result = normalizeClaudeCodeLine(multi)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ kind: 'user-text' })
    expect(result[1]).toMatchObject({ kind: 'assistant-text' })
  })
})
