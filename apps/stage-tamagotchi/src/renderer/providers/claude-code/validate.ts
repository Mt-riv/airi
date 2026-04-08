import type { ComposerTranslation } from 'vue-i18n'

import type { ClaudeCodeTransport } from './provider'

// Shared validator shape expected by Airi's provider registry. We keep a
// minimal local alias instead of importing from stage-ui so this module can
// stay tree-shakeable for tests.
export interface ValidationError {
  error: unknown
  errorKey?: string
}

export interface ValidationResult {
  errors: ValidationError[]
  reason: string
  reasonKey: string
  valid: boolean
}

export interface ClaudeCodeValidateInput {
  binaryPath?: unknown
  projectDir?: unknown
  sessionId?: unknown
}

const I18N_PREFIX = 'settings.pages.providers.provider.claude-code'

function translate(t: ComposerTranslation | undefined, key: string, fallback: string): string {
  if (!t)
    return fallback
  try {
    const translated = t(key)
    return typeof translated === 'string' && translated.length > 0 && translated !== key
      ? translated
      : fallback
  }
  catch {
    return fallback
  }
}

/**
 * Run the full settings-page validation for the Claude Code provider:
 * 1. Assert `projectDir` is a non-empty string.
 * 2. Resolve the project slug via `claudeCodeResolveSlug` (surface ENOENT
 *    / permission errors).
 * 3. Probe the configured binary via `claudeCodeCheckBinary` (catches
 *    missing binaries and unsupported versions).
 *
 * Returned `ValidationResult.errors` are structured so the settings form
 * can render them verbatim; `reason` is a pipe-joined summary for simple
 * tooltips. Transport failures (IPC throwing) are caught and converted
 * into a single `error` entry so validators never reject.
 */
export async function validateClaudeCodeConfig(
  input: ClaudeCodeValidateInput,
  transport: ClaudeCodeTransport,
  t?: ComposerTranslation,
): Promise<ValidationResult> {
  const errors: ValidationError[] = []

  const projectDir = typeof input.projectDir === 'string' ? input.projectDir.trim() : ''
  const binaryPath = typeof input.binaryPath === 'string' && input.binaryPath.trim().length > 0
    ? input.binaryPath.trim()
    : 'claude'

  if (projectDir.length === 0) {
    errors.push({
      error: new Error(translate(
        t,
        `${I18N_PREFIX}.errors.project-dir-required`,
        'Project directory is required.',
      )),
      errorKey: `${I18N_PREFIX}.errors.project-dir-required`,
    })
  }
  else {
    try {
      const slugResult = await transport.resolveSlug({ projectDir })
      if (!slugResult.ok) {
        errors.push({
          error: new Error(translate(
            t,
            `${I18N_PREFIX}.errors.project-dir-unreadable`,
            `Cannot resolve project directory: ${slugResult.error}`,
          )),
          errorKey: `${I18N_PREFIX}.errors.project-dir-unreadable`,
        })
      }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({
        error: new Error(translate(
          t,
          `${I18N_PREFIX}.errors.resolve-slug-transport`,
          `Failed to probe project directory: ${message}`,
        )),
        errorKey: `${I18N_PREFIX}.errors.resolve-slug-transport`,
      })
    }
  }

  try {
    const binaryResult = await transport.checkBinary({ binaryPath })
    if (!binaryResult.ok) {
      errors.push({
        error: new Error(translate(
          t,
          `${I18N_PREFIX}.errors.binary-not-found`,
          `Claude Code binary is not usable: ${binaryResult.error}`,
        )),
        errorKey: `${I18N_PREFIX}.errors.binary-not-found`,
      })
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push({
      error: new Error(translate(
        t,
        `${I18N_PREFIX}.errors.check-binary-transport`,
        `Failed to probe claude binary: ${message}`,
      )),
      errorKey: `${I18N_PREFIX}.errors.check-binary-transport`,
    })
  }

  return {
    errors,
    reason: errors.length > 0
      ? errors.map(entry => (entry.error as Error).message).join(' | ')
      : '',
    reasonKey: '',
    valid: errors.length === 0,
  }
}
