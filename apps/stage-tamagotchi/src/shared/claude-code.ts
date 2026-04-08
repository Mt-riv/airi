// Shared Claude Code integration types — usable from both the Electron main
// process and the renderer. The main-process service implementation lives at
// `src/main/services/airi/claude-code/` and re-exports these types via its
// own `types.ts` for internal imports.
//
// Source schema reference: docs/integrations/claude-code-jsonl-schema.md

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

/**
 * Outcome of a single `claude -p` invocation from the main process. Mirrors
 * `SendPromptResult` returned by the `SessionRunner` in Phase 1 so renderer
 * and main agree on the contract without the renderer having to import
 * main-only modules.
 */
export type ClaudeCodeSendPromptResult
  = | { ok: true, sessionId: string | null }
    | { ok: false, error: string, sessionId: string | null }

export interface ClaudeCodeListSessionsInput {
  projectDir: string
}

export interface ClaudeCodeAttachSessionInput {
  sessionId: string
  projectDir: string
}

export interface ClaudeCodeDetachSessionInput {
  sessionId: string
}

export interface ClaudeCodeSendPromptInput {
  projectDir: string
  sessionId: string | null
  text: string
}

export interface ClaudeCodeStreamEventPayload {
  sessionId: string
  event: NormalizedClaudeCodeEvent
}
