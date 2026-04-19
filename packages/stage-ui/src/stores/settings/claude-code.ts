import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

// Speech readout scope:
// - `current-project`: attach to the latest session under
//   `claude-code-speech-project-dir` (single configured project).
// - `all-projects-latest`: follow the latest session in every slug directory
//   under `~/.claude/projects/` — auto-switches to new sessions as they appear.
// - `manual-select`: read only the sessions the user explicitly checked in the
//   settings page. `selectedSessions` holds the allow-listed session IDs.
export type ClaudeCodeSpeechScope = 'current-project' | 'all-projects-latest' | 'manual-select'

export const CLAUDE_CODE_SPEECH_SCOPES = ['current-project', 'all-projects-latest', 'manual-select'] as const satisfies readonly ClaudeCodeSpeechScope[]

export const useSettingsClaudeCode = defineStore('settings-claude-code', () => {
  const showInChatHistory = useLocalStorageManualReset<boolean>('settings/claude-code/show-in-chat-history', false)
  const speechScope = useLocalStorageManualReset<ClaudeCodeSpeechScope>('settings/claude-code/speech-scope', 'current-project')
  // List of `{slug}::{sessionId}` pairs the user has opted in for speech
  // readout when `speechScope === 'manual-select'`. The slug is kept alongside
  // the sessionId so the composable can attach via `attachSessionBySlug`
  // without re-querying the manager for every entry.
  const selectedSessions = useLocalStorageManualReset<Array<{ slug: string, sessionId: string }>>(
    'settings/claude-code/selected-sessions',
    [],
  )

  const configured = computed(() => showInChatHistory.value)

  function resetState() {
    showInChatHistory.reset()
    speechScope.reset()
    selectedSessions.reset()
  }

  return {
    showInChatHistory,
    speechScope,
    selectedSessions,
    configured,
    resetState,
  }
})
