// The canonical type definitions live in `src/shared/claude-code.ts` so they
// can be consumed from both the Electron main process and the renderer
// without a main-only import. This module re-exports them for internal use
// so Phase 1 modules can keep their `./types` import paths unchanged.

export type {
  ClaudeCodeAttachSessionInput,
  ClaudeCodeCheckBinaryInput,
  ClaudeCodeCheckBinaryResult,
  ClaudeCodeDetachSessionInput,
  ClaudeCodeListSessionsInput,
  ClaudeCodeResolveSlugInput,
  ClaudeCodeResolveSlugResult,
  ClaudeCodeSendPromptInput,
  ClaudeCodeSendPromptResult,
  ClaudeCodeSession,
  ClaudeCodeSessionMeta,
  ClaudeCodeStreamEventPayload,
  NormalizedClaudeCodeEvent,
} from '../../../../shared/claude-code'
