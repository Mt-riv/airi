import { defineProvider } from '@proj-airi/stage-ui/libs/providers/providers/registry'

import { claudeCodeConfigSchema } from './config'
import { createClaudeCodeProvider } from './provider'

// Airi provider registration for the Claude Code CLI integration.
//
// Design notes:
// - The provider lives under `apps/stage-tamagotchi` (not stage-ui) because
//   it depends on Electron IPC (`@proj-airi/electron-vueuse`), which
//   stage-ui cannot pull in without becoming platform-specific.
// - Registration happens via a side-effect import from
//   `apps/stage-tamagotchi/src/renderer/main.ts` so that the stage-ui
//   `providerRegistry` singleton picks it up alongside the built-in
//   providers.
// - i18n keys live at
//   `settings.pages.providers.provider.claude-code.*` in
//   `packages/i18n/src/locales/{en,ja,zh-Hans}/settings.yaml`. The
//   `name` / `description` strings here are English fallbacks that are
//   only surfaced when the locale file is missing a translation.
const I18N_PREFIX = 'settings.pages.providers.provider.claude-code'

export const providerClaudeCode = defineProvider<typeof claudeCodeConfigSchema._input>({
  id: 'claude-code',
  order: 5,
  name: 'Claude Code',
  nameLocalize: ({ t }) => t(`${I18N_PREFIX}.title`),
  description: 'Bridge Airi chat with Anthropic\'s Claude Code CLI.',
  descriptionLocalize: ({ t }) => t(`${I18N_PREFIX}.description`),
  tasks: ['chat'],
  icon: 'i-simple-icons:anthropic',

  createProviderConfig: ({ t }) => claudeCodeConfigSchema.extend({
    binaryPath: claudeCodeConfigSchema.shape.binaryPath.meta({
      labelLocalized: t(`${I18N_PREFIX}.fields.field.binary-path.label`),
      descriptionLocalized: t(`${I18N_PREFIX}.fields.field.binary-path.description`),
      placeholderLocalized: t(`${I18N_PREFIX}.fields.field.binary-path.placeholder`),
    }),
    projectDir: claudeCodeConfigSchema.shape.projectDir.meta({
      labelLocalized: t(`${I18N_PREFIX}.fields.field.project-dir.label`),
      descriptionLocalized: t(`${I18N_PREFIX}.fields.field.project-dir.description`),
      placeholderLocalized: t(`${I18N_PREFIX}.fields.field.project-dir.placeholder`),
    }),
    sessionId: claudeCodeConfigSchema.shape.sessionId.meta({
      labelLocalized: t(`${I18N_PREFIX}.fields.field.session-id.label`),
      descriptionLocalized: t(`${I18N_PREFIX}.fields.field.session-id.description`),
      placeholderLocalized: t(`${I18N_PREFIX}.fields.field.session-id.placeholder`),
      section: 'advanced',
    }),
  }),

  createProvider(config) {
    // NOTICE: `defineProvider` hands us the raw input (pre-parse) to match
    //         its generic contract. Parse with the schema here so downstream
    //         code always works with defaults applied.
    const parsed = claudeCodeConfigSchema.parse(config)
    return createClaudeCodeProvider(parsed)
  },

  validationRequiredWhen: () => true,
  validators: {
    validateConfig: [
      () => ({
        id: 'claude-code:check-config',
        name: 'Check Claude Code configuration',
        validator: async (config) => {
          const errors: Array<{ error: unknown }> = []
          const result = claudeCodeConfigSchema.safeParse(config)

          if (!result.success) {
            for (const issue of result.error.issues) {
              errors.push({ error: new Error(issue.message) })
            }
          }

          return {
            errors,
            reason: errors.length > 0
              ? errors.map(entry => (entry.error as Error).message).join(', ')
              : '',
            reasonKey: '',
            valid: errors.length === 0,
          }
        },
      }),
    ],
  },
})
