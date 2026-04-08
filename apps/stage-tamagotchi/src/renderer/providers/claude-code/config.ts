import { z } from 'zod'

// Schema for the Claude Code provider settings surfaced in the Airi
// settings UI. Zod schemas also drive the auto-generated form via
// `createProviderConfig`. See
// docs/integrations/claude-code-jsonl-schema.md §7 for security context on
// why `projectDir` is required and `binaryPath` must be a plain string.
export const claudeCodeConfigSchema = z.object({
  binaryPath: z.string()
    .trim()
    .min(1, 'Binary path is required')
    .default('claude'),
  projectDir: z.string()
    .trim()
    .min(1, 'Project directory is required'),
  sessionId: z.string()
    .trim()
    .optional(),
})

export type ClaudeCodeConfig = z.input<typeof claudeCodeConfigSchema>
export type ClaudeCodeConfigParsed = z.infer<typeof claudeCodeConfigSchema>
