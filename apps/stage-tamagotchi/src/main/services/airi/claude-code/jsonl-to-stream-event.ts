import type { NormalizedClaudeCodeEvent } from './types'

// Claude Code's on-disk JSONL (`~/.claude/projects/<slug>/<uuid>.jsonl`) and
// stdout stream-json format carry different top-level event shapes but share
// enough vocabulary that we can normalise both through a single parser. See
// docs/integrations/claude-code-jsonl-schema.md for the exhaustive schema
// reference derived in Phase 0.
//
// Design goals:
//   - Pure function — no I/O, trivially testable.
//   - Lossless raw: every emitted event carries the original JSON so unknown
//     fields survive Claude Code version drift (R3 mitigation).
//   - Forward-compatible: unknown `type` values are bucketed into a single
//     `{ kind: 'unknown', raw }` entry rather than silently dropped.

interface RawEvent {
  type?: unknown
  subtype?: unknown
  uuid?: unknown
  message?: unknown
  content?: unknown
  error?: unknown
  result?: unknown
  stop_reason?: unknown
  is_error?: unknown
  durationMs?: unknown
  messageCount?: unknown
  event?: unknown
  [key: string]: unknown
}

interface RawMessage {
  id?: unknown
  role?: unknown
  content?: unknown
}

const META_TYPES = new Set([
  'file-history-snapshot',
  'attachment',
  'permission-mode',
  'last-prompt',
  'queue-operation',
  'create',
  'update',
  'rate_limit_event',
])

/**
 * Normalise a single line from a Claude Code JSONL file OR a single line from
 * `claude -p --output-format stream-json` stdout into zero-or-more Airi
 * `NormalizedClaudeCodeEvent`s. A single transcript message frequently maps
 * to multiple normalised events (e.g. assistant text + tool_use in one line).
 *
 * The line MAY contain trailing whitespace or be an empty / multi-line chunk
 * — the helper splits on `\n` for convenience so callers can hand it a newly
 * appended chunk without pre-splitting.
 */
export function normalizeClaudeCodeLine(input: string): NormalizedClaudeCodeEvent[] {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return []
  }

  const lines = trimmed.split('\n').map(line => line.trim()).filter(line => line.length > 0)

  const events: NormalizedClaudeCodeEvent[] = []
  for (const line of lines) {
    let parsed: RawEvent
    try {
      parsed = JSON.parse(line) as RawEvent
    }
    catch {
      events.push({ kind: 'unknown', uuid: '', raw: line })
      continue
    }

    const normalised = normaliseParsed(parsed)
    events.push(...normalised)
  }

  return events
}

function normaliseParsed(raw: RawEvent): NormalizedClaudeCodeEvent[] {
  const uuid = typeof raw.uuid === 'string' ? raw.uuid : ''
  const type = typeof raw.type === 'string' ? raw.type : undefined

  if (type === undefined) {
    return [{ kind: 'unknown', uuid, raw }]
  }

  if (type === 'user')
    return normaliseUser(raw, uuid)

  if (type === 'assistant')
    return normaliseAssistant(raw, uuid)

  if (type === 'system')
    return normaliseSystem(raw, uuid)

  if (type === 'result')
    return normaliseResult(raw, uuid)

  if (type === 'stream_event')
    return normaliseStreamEvent(raw, uuid)

  if (META_TYPES.has(type))
    return [{ kind: 'meta', uuid, type, raw }]

  return [{ kind: 'unknown', uuid, raw }]
}

function normaliseUser(raw: RawEvent, uuid: string): NormalizedClaudeCodeEvent[] {
  const message = raw.message as RawMessage | undefined

  // Attachment-carrying user envelopes have no message and should be treated
  // as metadata.
  if (message == null) {
    return [{ kind: 'meta', uuid, type: 'user', raw }]
  }

  const { content } = message

  if (typeof content === 'string') {
    return [{ kind: 'user-text', uuid, text: content, raw }]
  }

  if (Array.isArray(content)) {
    const events: NormalizedClaudeCodeEvent[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object')
        continue

      const blockType = (block as { type?: unknown }).type

      if (blockType === 'tool_result') {
        const toolResult = block as {
          tool_use_id?: unknown
          content?: unknown
          is_error?: unknown
        }
        events.push({
          kind: 'tool-result',
          uuid,
          toolCallId: typeof toolResult.tool_use_id === 'string' ? toolResult.tool_use_id : '',
          result: toolResult.content,
          isError: toolResult.is_error === true,
          raw: block,
        })
      }
      else if (blockType === 'text') {
        const textBlock = block as { text?: unknown }
        if (typeof textBlock.text === 'string') {
          events.push({ kind: 'user-text', uuid, text: textBlock.text, raw: block })
        }
      }
    }
    return events
  }

  return [{ kind: 'meta', uuid, type: 'user', raw }]
}

function normaliseAssistant(raw: RawEvent, uuid: string): NormalizedClaudeCodeEvent[] {
  const message = raw.message as RawMessage | undefined
  if (message == null)
    return [{ kind: 'meta', uuid, type: 'assistant', raw }]

  const { content } = message
  if (!Array.isArray(content))
    return [{ kind: 'meta', uuid, type: 'assistant', raw }]

  // NOTICE: Capture the assistant message id (e.g. `msg_…`) so downstream
  // consumers can dedupe identical TUI snapshots that share a logical
  // message but get written to multiple JSONL lines with distinct envelope
  // uuids. See docs/integrations/claude-code-jsonl-schema.md §5.
  const messageId = typeof message.id === 'string' ? message.id : undefined

  const events: NormalizedClaudeCodeEvent[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object')
      continue

    const blockType = (block as { type?: unknown }).type

    if (blockType === 'text') {
      const textBlock = block as { text?: unknown }
      if (typeof textBlock.text === 'string') {
        events.push({ kind: 'assistant-text', uuid, messageId, text: textBlock.text, raw: block })
      }
    }
    else if (blockType === 'thinking') {
      const thinkingBlock = block as { thinking?: unknown }
      if (typeof thinkingBlock.thinking === 'string') {
        events.push({ kind: 'assistant-thinking', uuid, messageId, text: thinkingBlock.thinking, raw: block })
      }
    }
    else if (blockType === 'tool_use') {
      const toolUse = block as { id?: unknown, name?: unknown, input?: unknown }
      events.push({
        kind: 'tool-call',
        uuid,
        messageId,
        toolCallId: typeof toolUse.id === 'string' ? toolUse.id : '',
        toolName: typeof toolUse.name === 'string' ? toolUse.name : '',
        args: toolUse.input,
        raw: block,
      })
    }
  }

  return events
}

function normaliseSystem(raw: RawEvent, uuid: string): NormalizedClaudeCodeEvent[] {
  const subtype = typeof raw.subtype === 'string' ? raw.subtype : ''

  if (subtype === 'api_error') {
    return [{
      kind: 'error',
      uuid,
      error: extractApiErrorMessage(raw),
      raw,
    }]
  }

  if (subtype === 'turn_duration') {
    return [{ kind: 'finish', uuid, reason: 'turn_duration', raw }]
  }

  return [{ kind: 'meta', uuid, type: `system:${subtype}`, raw }]
}

function normaliseResult(raw: RawEvent, uuid: string): NormalizedClaudeCodeEvent[] {
  if (raw.is_error === true) {
    return [{
      kind: 'error',
      uuid,
      error: typeof raw.result === 'string' ? raw.result : String(raw.result ?? 'result error'),
      raw,
    }]
  }

  const reason = typeof raw.stop_reason === 'string' ? raw.stop_reason : 'end_turn'
  return [{ kind: 'finish', uuid, reason, raw }]
}

function normaliseStreamEvent(raw: RawEvent, uuid: string): NormalizedClaudeCodeEvent[] {
  const inner = raw.event
  if (!inner || typeof inner !== 'object')
    return [{ kind: 'meta', uuid, type: 'stream_event', raw }]

  const { type: innerType } = inner as { type?: unknown }

  if (innerType === 'content_block_delta') {
    const { delta } = inner as { delta?: unknown }
    if (delta && typeof delta === 'object') {
      const deltaType = (delta as { type?: unknown }).type
      if (deltaType === 'text_delta') {
        const text = (delta as { text?: unknown }).text
        if (typeof text === 'string') {
          return [{ kind: 'assistant-text', uuid, text, raw }]
        }
      }
      if (deltaType === 'thinking_delta') {
        const thinking = (delta as { thinking?: unknown }).thinking
        if (typeof thinking === 'string') {
          return [{ kind: 'assistant-thinking', uuid, text: thinking, raw }]
        }
      }
    }
  }

  return [{ kind: 'meta', uuid, type: 'stream_event', raw }]
}

function extractApiErrorMessage(raw: RawEvent): string {
  const error = raw.error
  if (error && typeof error === 'object') {
    const nested = (error as { error?: unknown }).error
    if (nested && typeof nested === 'object') {
      const message = (nested as { message?: unknown }).message
      if (typeof message === 'string')
        return message
    }
    const topLevelMessage = (error as { message?: unknown }).message
    if (typeof topLevelMessage === 'string')
      return topLevelMessage
  }
  return 'Claude Code API error'
}
