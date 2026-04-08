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
// - The localised strings are left as direct fallbacks here; Phase 4
//   introduces proper `packages/i18n` keys.
export const providerClaudeCode = defineProvider<typeof claudeCodeConfigSchema._input>({
  id: 'claude-code',
  order: 5,
  name: 'Claude Code',
  nameLocalize: () => 'Claude Code',
  description: 'Bridge Airi chat with Anthropic\'s Claude Code CLI.',
  descriptionLocalize: () => 'Bridge Airi chat with Anthropic\'s Claude Code CLI.',
  tasks: ['chat'],
  icon: 'i-simple-icons:anthropic',

  createProviderConfig: () => claudeCodeConfigSchema.meta({
    title: 'Claude Code',
    description: 'Mirror and drive an Anthropic Claude Code CLI session from Airi chat.',
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
