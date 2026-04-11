import type { NormalizedClaudeCodeEvent } from '../../shared/claude-code'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { useCharacterStore } from '@proj-airi/stage-ui/stores/character'
import { useLocalStorage } from '@vueuse/core'
import { ref, watch } from 'vue'

// NOTICE: Import from the main-process module is safe here because
//         text-filter.ts is a pure function with no Node.js-only deps.
//         Vite resolves it as a source import in the renderer bundle.
import { cleanTextForSpeech } from '../../main/services/airi/claude-code/text-filter'
import {
  claudeCodeAttachSession,
  claudeCodeListSessions,
  claudeCodeStreamEvent,
} from '../../shared/eventa'

/**
 * Composable that watches Claude Code JSONL session logs and triggers
 * Airi's character to read aloud assistant responses via the existing
 * TTS pipeline (`characterStore.emitTextOutput`).
 *
 * Mount this from the stage (main) window's `index.vue` — that window
 * is the chat-sync authority and has the Eventa context wired to the
 * main process's `ClaudeCodeManager`.
 *
 * Inspired by cc-mascot's passive log-monitoring approach.
 */
export function useClaudeCodeSpeech() {
  const enabled = useLocalStorage('claude-code-speech-enabled', false)
  const projectDir = useLocalStorage('claude-code-speech-project-dir', '')
  const currentSessionId = ref<string | null>(null)
  const isAttached = ref(false)

  const characterStore = useCharacterStore()

  // Eventa IPC
  const context = getElectronEventaContext()
  const invokeListSessions = defineInvoke(context, claudeCodeListSessions)
  const invokeAttachSession = defineInvoke(context, claudeCodeAttachSession)

  // Single persistent IPC listener for stream events.
  // Activated/deactivated via the `enabled` flag — when disabled, events
  // are received but silently dropped.
  context.on(claudeCodeStreamEvent, (raw) => {
    if (!enabled.value || !isAttached.value)
      return

    try {
      // Unwrap the Eventa electron adapter envelope { id, type, _flowDirection, body }
      const envelope = raw as unknown as Record<string, unknown>
      const inner = (envelope.body != null && typeof envelope.body === 'object'
        ? envelope.body
        : envelope) as Record<string, unknown>

      const event = inner.event as NormalizedClaudeCodeEvent | undefined
      if (!event || typeof event !== 'object' || !('kind' in event))
        return

      // Only process assistant text — skip tool-calls, meta, thinking, etc.
      if (event.kind !== 'assistant-text')
        return

      const cleaned = cleanTextForSpeech(event.text)
      if (cleaned.length === 0)
        return

      characterStore.emitTextOutput(cleaned)
    }
    catch {
      // Silently ignore malformed events — the watcher is best-effort.
    }
  })

  /**
   * Attach to the most recently modified JSONL session for the configured
   * project directory. Called automatically when `enabled` or `projectDir`
   * changes, or can be triggered manually.
   */
  async function attachToLatestSession() {
    if (!projectDir.value || !enabled.value) {
      isAttached.value = false
      currentSessionId.value = null
      return
    }

    try {
      const sessions = await invokeListSessions({ projectDir: projectDir.value })
      if (!sessions || sessions.length === 0) {
        isAttached.value = false
        return
      }

      // Sessions are sorted newest-first by the manager.
      const latest = sessions[0]
      currentSessionId.value = latest.meta.sessionId

      await invokeAttachSession({
        sessionId: latest.meta.sessionId,
        projectDir: projectDir.value,
      })

      isAttached.value = true
    }
    catch {
      isAttached.value = false
      currentSessionId.value = null
    }
  }

  // Auto-attach when enabled or projectDir changes.
  watch([enabled, projectDir], () => {
    if (enabled.value && projectDir.value) {
      attachToLatestSession()
    }
    else {
      isAttached.value = false
      currentSessionId.value = null
    }
  }, { immediate: true })

  return {
    /** Whether Claude Code speech readout is active. */
    enabled,
    /** The project directory to monitor. */
    projectDir,
    /** The session ID currently being watched (null if not attached). */
    currentSessionId,
    /** Whether the watcher is actively attached to a session. */
    isAttached,
    /** Manually re-attach to the latest session. */
    attachToLatestSession,
  }
}
