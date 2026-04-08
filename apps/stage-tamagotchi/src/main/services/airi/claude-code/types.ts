// Shared types for the Claude Code integration service.
//
// See docs/integrations/claude-code-jsonl-schema.md for the source-of-truth
// schema documentation derived in Phase 0.

/**
 * A parsed Claude Code transcript / stream event, normalised to Airi's
 * internal shape. The raw JSON is preserved so downstream code can recover
 * fields we have not explicitly modelled yet.
 */
export type NormalizedClaudeCodeEvent
  = | { kind: 'user-text', uuid: string, text: string, raw: unknown }
    | { kind: 'assistant-text', uuid: string, text: string, raw: unknown }
    | { kind: 'assistant-thinking', uuid: string, text: string, raw: unknown }
    | {
      kind: 'tool-call'
      uuid: string
      toolCallId: string
      toolName: string
      args: unknown
      raw: unknown
    }
    | {
      kind: 'tool-result'
      uuid: string
      toolCallId: string
      result: unknown
      isError: boolean
      raw: unknown
    }
    | { kind: 'finish', uuid: string, reason: string, raw: unknown }
    | { kind: 'error', uuid: string, error: string, raw: unknown }
    | { kind: 'meta', uuid: string, type: string, raw: unknown }
    | { kind: 'unknown', uuid: string, raw: unknown }

export interface ClaudeCodeSessionMeta {
  sessionId: string
  slug: string
  filePath: string
  cwd?: string
  gitBranch?: string
  startedAt?: string
  lastEventAt?: string
  eventCount: number
}

export interface ClaudeCodeSession {
  meta: ClaudeCodeSessionMeta
  running: boolean
}
