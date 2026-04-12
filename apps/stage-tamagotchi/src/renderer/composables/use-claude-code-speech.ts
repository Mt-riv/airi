import type { NormalizedClaudeCodeEvent } from '../../shared/claude-code'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { useCharacterStore } from '@proj-airi/stage-ui/stores/character'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useSettingsClaudeCode } from '@proj-airi/stage-ui/stores/settings/claude-code'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
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

// NOTICE: Claude Code TUI writes the SAME logical assistant message to the
// on-disk JSONL multiple times — intermediate snapshots followed by the
// final version. Each line gets a fresh envelope `uuid` but they share the
// SAME `message.id` (e.g. `msg_…`). Without deduplication every snapshot
// would be spoken AND appended to chat history, producing 4–7 repeats per
// turn. We dedup by `messageId` and keep a small LRU set so the memory
// footprint stays bounded across long sessions.
//
// See docs/integrations/claude-code-jsonl-schema.md §5 "Dedupe rule".
const MAX_SEEN_MESSAGE_IDS = 100

const CHAT_HISTORY_FLUSH_DELAY_MS = 1500

/**
 * Composable that watches Claude Code JSONL session logs and triggers
 * Airi's character to read aloud assistant responses via the existing
 * TTS pipeline (`characterStore.emitTextOutput`).
 *
 * Optionally appends Claude Code assistant responses to the chat history
 * when the `showInChatHistory` setting is enabled.
 *
 * Mount this from the stage (main) window's `index.vue` — that window
 * is the chat-sync authority and has the Eventa context wired to the
 * main process's `ClaudeCodeManager`.
 *
 * Controlled via localStorage:
 *   - `claude-code-speech-enabled`: boolean
 *   - `claude-code-speech-project-dir`: absolute path string
 *   - `settings/claude-code/show-in-chat-history`: boolean (via settings store)
 */
export function useClaudeCodeSpeech() {
  const enabled = useLocalStorage('claude-code-speech-enabled', false)
  const projectDir = useLocalStorage('claude-code-speech-project-dir', '')
  const currentSessionId = ref<string | null>(null)
  const isAttached = ref(false)

  const characterStore = useCharacterStore()
  const chatSessionStore = useChatSessionStore()
  const claudeCodeSettings = useSettingsClaudeCode()
  const { showInChatHistory } = storeToRefs(claudeCodeSettings)

  // --- Deduplication state (shared by speech + chat history) ---
  const seenMessageIds = new Set<string>()

  function shouldSkipDuplicate(messageId: string | undefined): boolean {
    if (!messageId)
      return false
    if (seenMessageIds.has(messageId))
      return true
    seenMessageIds.add(messageId)
    if (seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
      const first = seenMessageIds.values().next().value
      if (first !== undefined)
        seenMessageIds.delete(first)
    }
    return false
  }

  // --- Chat history buffering ---
  // Multiple `assistant-text` events can fire in quick succession for one
  // turn (one per text content block). Buffer briefly and flush as a single
  // message so the chat history doesn't fragment.
  let chatHistoryBuffer = ''
  let chatHistoryFlushTimer: ReturnType<typeof setTimeout> | undefined

  function flushChatHistoryBuffer() {
    chatHistoryFlushTimer = undefined
    const text = chatHistoryBuffer.trim()
    chatHistoryBuffer = ''

    if (text.length === 0)
      return

    const sessionId = chatSessionStore.activeSessionId
    if (!sessionId)
      return

    chatSessionStore.appendSessionMessage(sessionId, {
      role: 'assistant',
      content: `[Claude Code] ${text}`,
      slices: [{ type: 'text', text: `[Claude Code] ${text}` }],
      tool_results: [],
      createdAt: Date.now(),
      id: `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    })
  }

  function appendToChatHistoryBuffer(text: string) {
    chatHistoryBuffer += text

    if (chatHistoryFlushTimer !== undefined)
      clearTimeout(chatHistoryFlushTimer)
    chatHistoryFlushTimer = setTimeout(flushChatHistoryBuffer, CHAT_HISTORY_FLUSH_DELAY_MS)
  }

  // --- Eventa IPC ---
  const context = getElectronEventaContext()
  const invokeListSessions = defineInvoke(context, claudeCodeListSessions)
  const invokeAttachSession = defineInvoke(context, claudeCodeAttachSession)

  context.on(claudeCodeStreamEvent, (raw) => {
    if (!isAttached.value)
      return
    if (!enabled.value && !showInChatHistory.value)
      return

    try {
      const envelope = raw as unknown as Record<string, unknown>
      const inner = (envelope.body != null && typeof envelope.body === 'object'
        ? envelope.body
        : envelope) as Record<string, unknown>

      const event = inner.event as NormalizedClaudeCodeEvent | undefined
      if (!event || typeof event !== 'object' || !('kind' in event))
        return

      if (event.kind !== 'assistant-text')
        return

      // Dedup intermediate-snapshot duplicates from Claude Code TUI.
      if (shouldSkipDuplicate(event.messageId))
        return

      // --- Speech readout ---
      if (enabled.value) {
        const cleaned = cleanTextForSpeech(event.text)
        if (cleaned.length > 0) {
          characterStore.emitTextOutput(cleaned).catch(() => {
            // Best-effort — swallow TTS errors so the watcher keeps running.
          })
        }
      }

      // --- Chat history ---
      if (showInChatHistory.value && event.text.length > 0) {
        appendToChatHistoryBuffer(event.text)
      }
    }
    catch {
      // Silently ignore malformed events.
    }
  })

  async function attachToLatestSession() {
    if (!projectDir.value || (!enabled.value && !showInChatHistory.value)) {
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

  watch([enabled, showInChatHistory, projectDir], () => {
    if ((enabled.value || showInChatHistory.value) && projectDir.value) {
      attachToLatestSession()
    }
    else {
      isAttached.value = false
      currentSessionId.value = null
    }
  }, { immediate: true })

  return {
    enabled,
    projectDir,
    currentSessionId,
    isAttached,
    attachToLatestSession,
  }
}
