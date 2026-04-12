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
    // NOTICE: `messageId` is the assistant `message.id` (e.g. `msg_…`) — NOT
    // the JSONL envelope `uuid`. Claude Code TUI writes the same logical
    // assistant response to the on-disk JSONL multiple times (intermediate
    // snapshots + final), each with a fresh envelope `uuid` but the SAME
    // `message.id`. Dedup MUST use `messageId` to avoid repeated readouts.
    // See docs/integrations/claude-code-jsonl-schema.md §5 "Dedupe rule".
    | { kind: 'assistant-text', uuid: string, messageId?: string, text: string, raw: unknown }
    | { kind: 'assistant-thinking', uuid: string, messageId?: string, text: string, raw: unknown }
    | {
      kind: 'tool-call'
      uuid: string
      messageId?: string
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

/**
 * Result of probing the configured `claude` binary. The check runs
 * `claude --version` on the main process so renderer validators can show
 * whether the binary is usable without the user having to try sending a
 * prompt first.
 */
export type ClaudeCodeCheckBinaryResult
  = | { ok: true, version: string, path: string }
    | { ok: false, error: string }

export interface ClaudeCodeCheckBinaryInput {
  binaryPath: string
}

/**
 * Result of resolving a raw `projectDir` to its canonical realpath + the
 * Claude Code project slug it maps to. Used by the settings page to show
 * the user a live preview of `~/.claude/projects/<slug>` so they can
 * double-check the directory mapping before saving.
 */
export type ClaudeCodeResolveSlugResult
  = | { ok: true, realPath: string, slug: string }
    | { ok: false, error: string }

export interface ClaudeCodeResolveSlugInput {
  projectDir: string
}
