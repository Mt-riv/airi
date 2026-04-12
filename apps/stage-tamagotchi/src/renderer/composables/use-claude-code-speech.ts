import type { NormalizedClaudeCodeEvent } from '../../shared/claude-code'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules'
import { useSettingsClaudeCode } from '@proj-airi/stage-ui/stores/settings/claude-code'
import { useSpeechRuntimeStore } from '@proj-airi/stage-ui/stores/speech-runtime'
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

const CHAT_HISTORY_FLUSH_DELAY_MS = 1500

// NOTICE: Claude Code JSONL transcript logs contain TWO representations of
// the same assistant response:
//   1. `stream_event` entries with `content_block_delta` — incremental text
//      deltas emitted during streaming.
//   2. A final `assistant` entry — the full message with all content blocks.
//
// Both are normalised to `assistant-text` events by `jsonl-to-stream-event.ts`.
// Without deduplication the same text would be spoken and/or recorded twice.
//
// Strategy: track UUIDs that produced `assistant-text` from `stream_event`
// deltas. When the final `assistant` entry arrives for the same UUID, skip it.
// If no deltas were seen (e.g. the watcher attached after streaming finished),
// the `assistant` entry is the only source and gets processed normally.
const MAX_SEEN_UUIDS = 50

// How long to wait after the last streaming delta before closing the speech
// intent. This allows the TTS pipeline to chunk and synthesize accumulated
// text while waiting for more deltas.
const SPEECH_INTENT_IDLE_MS = 2000

/**
 * Composable that watches Claude Code JSONL session logs and triggers
 * Airi's character to read aloud assistant responses via the existing
 * TTS pipeline.
 *
 * Uses a single streaming speech intent per response turn — text deltas
 * are written incrementally via `writeLiteral()` so the TTS pipeline can
 * chunk and synthesize in near real-time without creating a separate
 * intent per delta.
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

  const speechRuntimeStore = useSpeechRuntimeStore()
  const { activeCard } = storeToRefs(useAiriCardStore())
  const chatSessionStore = useChatSessionStore()
  const claudeCodeSettings = useSettingsClaudeCode()
  const { showInChatHistory } = storeToRefs(claudeCodeSettings)

  // --- Deduplication state ---
  const seenStreamingUuids = new Set<string>()

  // --- Streaming speech intent state ---
  // One intent is kept open per response turn (identified by UUID). Text
  // deltas are written incrementally; an idle timer closes the intent once
  // no new deltas arrive.
  let activeSpeechIntent: ReturnType<typeof speechRuntimeStore.openIntent> | null = null
  let activeSpeechUuid = ''
  let speechIdleTimer: ReturnType<typeof setTimeout> | undefined

  function closeSpeechIntent() {
    if (speechIdleTimer !== undefined) {
      clearTimeout(speechIdleTimer)
      speechIdleTimer = undefined
    }
    if (activeSpeechIntent) {
      activeSpeechIntent.writeFlush()
      activeSpeechIntent.end()
      activeSpeechIntent = null
      activeSpeechUuid = ''
    }
  }

  function resetSpeechIdleTimer() {
    if (speechIdleTimer !== undefined)
      clearTimeout(speechIdleTimer)
    speechIdleTimer = setTimeout(closeSpeechIntent, SPEECH_INTENT_IDLE_MS)
  }

  function writeSpeechDelta(text: string, uuid: string) {
    // If a different UUID arrives, close the previous intent first.
    if (activeSpeechUuid && activeSpeechUuid !== uuid)
      closeSpeechIntent()

    if (!activeSpeechIntent) {
      activeSpeechIntent = speechRuntimeStore.openIntent({
        ownerId: activeCard.value?.name ?? 'default',
        priority: 'normal',
        behavior: 'queue',
      })
      activeSpeechUuid = uuid
    }

    activeSpeechIntent.writeLiteral(text)
    resetSpeechIdleTimer()
  }

  // --- Chat history buffering ---
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

  // --- UUID tracking ---
  function trackSeenUuid(uuid: string) {
    seenStreamingUuids.add(uuid)
    if (seenStreamingUuids.size > MAX_SEEN_UUIDS) {
      const first = seenStreamingUuids.values().next().value
      if (first !== undefined)
        seenStreamingUuids.delete(first)
    }
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

      // --- Deduplication ---
      // Detect streaming delta vs final assistant entry via the `raw` field.
      // Streaming deltas originate from `stream_event` → `content_block_delta`
      // and carry a `delta` object. Final assistant entries carry a content
      // block with `type: 'text'`.
      const rawObj = event.raw as Record<string, unknown> | undefined
      const isStreamingDelta = rawObj != null && 'delta' in rawObj

      if (isStreamingDelta) {
        if (event.uuid)
          trackSeenUuid(event.uuid)
      }
      else {
        // Full assistant entry — skip if we already processed deltas.
        if (event.uuid && seenStreamingUuids.has(event.uuid))
          return
      }

      // --- Speech readout ---
      if (enabled.value) {
        const cleaned = cleanTextForSpeech(event.text)
        if (cleaned.length > 0) {
          if (isStreamingDelta) {
            // Write into a single streaming intent (one per response turn).
            writeSpeechDelta(cleaned, event.uuid || '')
          }
          else {
            // Full assistant entry (no prior deltas) — single emit.
            closeSpeechIntent()
            writeSpeechDelta(cleaned, event.uuid || '')
            closeSpeechIntent()
          }
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
