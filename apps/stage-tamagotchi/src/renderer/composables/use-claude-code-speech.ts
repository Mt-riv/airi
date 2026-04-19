import type { NormalizedClaudeCodeEvent } from '../../shared/claude-code'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { useCharacterStore } from '@proj-airi/stage-ui/stores/character'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useSettingsClaudeCode } from '@proj-airi/stage-ui/stores/settings/claude-code'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { onScopeDispose, ref, watch } from 'vue'

// NOTICE: Import from the main-process module is safe here because
//         text-filter.ts is a pure function with no Node.js-only deps.
//         Vite resolves it as a source import in the renderer bundle.
import { cleanTextForSpeech } from '../../main/services/airi/claude-code/text-filter'
import {
  claudeCodeAttachSession,
  claudeCodeAttachSessionBySlug,
  claudeCodeDetachSession,
  claudeCodeListAllProjects,
  claudeCodeListAllSessions,
  claudeCodeListSessions,
  claudeCodeStreamEvent,
} from '../../shared/eventa'

// NOTICE: Claude Code TUI writes the SAME logical assistant message to the
// on-disk JSONL multiple times — intermediate snapshots followed by the
// final version. Each line gets a fresh envelope `uuid` but they share the
// SAME `message.id` (e.g. `msg_…`). Without deduplication every snapshot
// would be spoken AND appended to chat history, producing 4–7 repeats per
// turn.
//
// NOTICE: `seenMessageIds` MUST be module-scoped (not per-composable). The
// renderer eventa context is a singleton, so if the composable re-runs
// (HMR, route navigation, etc.) without this being module-scoped, each
// invocation would create its own Set and register a new listener — the
// dedup would be per-listener instead of global, and N accumulated listeners
// would produce N copies of the same message.
const MAX_SEEN_MESSAGE_IDS = 100
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

const CHAT_HISTORY_FLUSH_DELAY_MS = 1500

// Poll interval for `all-projects-latest` scope. Each cycle does a readdir +
// stat pass over every slug directory — cheap for the ~handful of Claude
// Code projects a dev typically has. A short cadence matters: `claude` in a
// new project creates a fresh JSONL, and anything we miss before we attach
// is silently dropped by our tail-only fallback.
const ALL_PROJECTS_POLL_MS = 5_000

// Split on either Unix or Windows path separators. Hoisted to module scope
// so it is not recompiled on every `deriveProjectName` call.
const PATH_SEPARATOR_RE = /[\\/]/

export function useClaudeCodeSpeech() {
  const enabled = useLocalStorage('claude-code-speech-enabled', false)
  const projectDir = useLocalStorage('claude-code-speech-project-dir', '')

  const characterStore = useCharacterStore()
  const chatSessionStore = useChatSessionStore()
  const claudeCodeSettings = useSettingsClaudeCode()
  const { showInChatHistory, speechScope, selectedSessions } = storeToRefs(claudeCodeSettings)

  // sessionId → { slug, projectName } for every currently attached session.
  // Used to gate incoming stream events (only speak/log events for sessions
  // we attached), drive detach during reconciliation, and prefix chat
  // history entries with a human-readable project label.
  const attachedSessions = ref(new Map<string, { slug: string, projectName: string }>())

  // Tracks whether we've completed the initial all-projects reconcile for
  // this composable lifetime. The first pass attaches with `tailOnly: true`
  // to skip any pre-existing assistant text in slug latest files (those can
  // contain hours of old turns). On subsequent passes, any newly-appeared
  // sessionId came from a `claude` invocation that started while Airi was
  // running, so we replay from the file's current head to catch the first
  // one or two turns the user just typed.
  let hasCompletedInitialAllProjectsReconcile = false

  // --- Chat history buffering ---
  // The buffer holds text from at most ONE Claude Code session at a time.
  // When an event from a different session arrives mid-buffer, we flush the
  // current buffer before starting the new one so each appended chat message
  // carries the correct `[Claude Code/<project>]` label.
  let chatHistoryBuffer = ''
  let chatHistoryBufferSessionId: string | null = null
  let chatHistoryFlushTimer: ReturnType<typeof setTimeout> | undefined

  // Claude Code slugs replace path separators with `-`, so `~/.claude/projects/
  // -Users-alice-dev-airi` maps back to `airi`. This is lossy for projects
  // whose directory names contain `-` (e.g. `my-cool-app` → `app`), so we
  // prefer `cwd` basename when the session meta carries it.
  function deriveProjectName(slug: string, cwd?: string): string {
    if (cwd != null && cwd.length > 0) {
      const basename = cwd.split(PATH_SEPARATOR_RE).filter(Boolean).pop()
      if (basename != null && basename.length > 0)
        return basename
    }
    const parts = slug.split('-').filter(Boolean)
    return parts.at(-1) ?? slug
  }

  function flushChatHistoryBuffer() {
    chatHistoryFlushTimer = undefined
    const text = chatHistoryBuffer.trim()
    const flushedSessionId = chatHistoryBufferSessionId
    chatHistoryBuffer = ''
    chatHistoryBufferSessionId = null

    if (text.length === 0)
      return

    const sessionId = chatSessionStore.activeSessionId
    if (!sessionId)
      return

    const entry = flushedSessionId != null
      ? attachedSessions.value.get(flushedSessionId)
      : undefined
    const label = entry != null ? `[Claude Code/${entry.projectName}]` : '[Claude Code]'
    const content = `${label} ${text}`

    chatSessionStore.appendSessionMessage(sessionId, {
      role: 'assistant',
      content,
      slices: [{ type: 'text', text: content }],
      tool_results: [],
      createdAt: Date.now(),
      id: `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    })
  }

  function appendToChatHistoryBuffer(sessionId: string, text: string) {
    if (chatHistoryBufferSessionId != null && chatHistoryBufferSessionId !== sessionId) {
      if (chatHistoryFlushTimer !== undefined)
        clearTimeout(chatHistoryFlushTimer)
      flushChatHistoryBuffer()
    }

    chatHistoryBufferSessionId = sessionId
    chatHistoryBuffer += text

    if (chatHistoryFlushTimer !== undefined)
      clearTimeout(chatHistoryFlushTimer)
    chatHistoryFlushTimer = setTimeout(flushChatHistoryBuffer, CHAT_HISTORY_FLUSH_DELAY_MS)
  }

  // --- Eventa IPC ---
  const context = getElectronEventaContext()
  const invokeListSessions = defineInvoke(context, claudeCodeListSessions)
  const invokeAttachSession = defineInvoke(context, claudeCodeAttachSession)
  const invokeAttachSessionBySlug = defineInvoke(context, claudeCodeAttachSessionBySlug)
  const invokeDetachSession = defineInvoke(context, claudeCodeDetachSession)
  const invokeListAllProjects = defineInvoke(context, claudeCodeListAllProjects)
  const invokeListAllSessions = defineInvoke(context, claudeCodeListAllSessions)

  const unsubscribe = context.on(claudeCodeStreamEvent, (raw) => {
    if (!enabled.value && !showInChatHistory.value)
      return

    try {
      const envelope = raw as unknown as Record<string, unknown>
      const inner = (envelope.body != null && typeof envelope.body === 'object'
        ? envelope.body
        : envelope) as Record<string, unknown>

      const sessionId = typeof inner.sessionId === 'string' ? inner.sessionId : null
      if (sessionId == null || !attachedSessions.value.has(sessionId))
        return

      const event = inner.event as NormalizedClaudeCodeEvent | undefined
      if (!event || typeof event !== 'object' || !('kind' in event))
        return

      if (event.kind !== 'assistant-text')
        return

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
        appendToChatHistoryBuffer(sessionId, event.text)
      }
    }
    catch {
      // Silently ignore malformed events.
    }
  })

  // --- Attach / detach helpers ---

  async function detachSession(sessionId: string) {
    attachedSessions.value.delete(sessionId)
    try {
      await invokeDetachSession({ sessionId })
    }
    catch {
      // Already detached or main-side error — nothing actionable.
    }
  }

  async function detachAll() {
    const sessionIds = Array.from(attachedSessions.value.keys())
    await Promise.allSettled(sessionIds.map(detachSession))
  }

  async function reconcileCurrentProject() {
    if (!projectDir.value) {
      await detachAll()
      return
    }

    try {
      const sessions = await invokeListSessions({ projectDir: projectDir.value })
      if (!sessions || sessions.length === 0) {
        await detachAll()
        return
      }

      const latest = sessions[0]
      const desired = new Set([latest.meta.sessionId])

      // Detach anything that is not the desired session.
      for (const sessionId of Array.from(attachedSessions.value.keys())) {
        if (!desired.has(sessionId))
          await detachSession(sessionId)
      }

      if (!attachedSessions.value.has(latest.meta.sessionId)) {
        await invokeAttachSession({
          sessionId: latest.meta.sessionId,
          projectDir: projectDir.value,
        })
        attachedSessions.value.set(latest.meta.sessionId, {
          slug: latest.meta.slug,
          projectName: deriveProjectName(latest.meta.slug, latest.meta.cwd),
        })
      }
    }
    catch {
      // Leave the attached set as-is on transient errors; the next reconcile
      // will retry.
    }
  }

  async function reconcileAllProjectsLatest() {
    try {
      const projects = await invokeListAllProjects({})
      const desired = new Map<string, { slug: string, projectName: string }>()
      for (const project of projects) {
        if (project.latestSession != null) {
          desired.set(project.latestSession.sessionId, {
            slug: project.latestSession.slug,
            projectName: deriveProjectName(project.latestSession.slug, project.latestSession.cwd),
          })
        }
      }

      // Detach sessions that are no longer the latest in their slug. This
      // happens when a user starts a new Claude Code session — the previous
      // latest.jsonl stops growing and the new session takes over.
      for (const sessionId of Array.from(attachedSessions.value.keys())) {
        if (!desired.has(sessionId))
          await detachSession(sessionId)
      }

      // First pass: skip existing content (could be hours of stale history).
      // Subsequent passes: a new sessionId means `claude` was just started in
      // some slug while Airi was running, so we can safely replay the file
      // from its head — it has at most the one or two turns the user just
      // typed, and we want the user to hear the assistant's reply.
      const tailOnlyForNewAttaches = !hasCompletedInitialAllProjectsReconcile

      for (const [sessionId, entry] of desired) {
        if (attachedSessions.value.has(sessionId))
          continue
        try {
          await invokeAttachSessionBySlug({ sessionId, slug: entry.slug, tailOnly: tailOnlyForNewAttaches })
          attachedSessions.value.set(sessionId, entry)
        }
        catch {
          // Skip this session; next poll will retry.
        }
      }

      hasCompletedInitialAllProjectsReconcile = true
    }
    catch {
      // Leave attached state unchanged on transient errors.
    }
  }

  // In manual-select mode we trust the user's opt-in list verbatim. For each
  // picked (slug, sessionId) pair we look up the session meta from
  // `listAllSessions` (to recover cwd for a human-friendly project label),
  // then attach with `tailOnly: true` — the user already accepted that old
  // history in the file is ignored; only freshly appended assistant turns
  // should be read aloud.
  async function reconcileManualSelect() {
    try {
      const picked = selectedSessions.value
      if (!Array.isArray(picked) || picked.length === 0) {
        await detachAll()
        return
      }

      // Build a slug → session metadata lookup so we can derive project
      // names even for sessions that no longer exist on disk. Tolerate the
      // RPC failing (e.g., transient fs issue) by falling back to an empty
      // map — callers still get attached, just without a pretty label.
      const projects = await invokeListAllSessions({}).catch(() => [] as Awaited<ReturnType<typeof invokeListAllSessions>>)
      const sessionLookup = new Map<string, { slug: string, cwd?: string }>()
      for (const project of projects) {
        for (const session of project.sessions)
          sessionLookup.set(`${project.slug}::${session.sessionId}`, { slug: project.slug, cwd: session.cwd })
      }

      const desired = new Map<string, { slug: string, projectName: string }>()
      for (const entry of picked) {
        if (typeof entry?.slug !== 'string' || typeof entry?.sessionId !== 'string')
          continue
        const meta = sessionLookup.get(`${entry.slug}::${entry.sessionId}`)
        desired.set(entry.sessionId, {
          slug: entry.slug,
          projectName: deriveProjectName(entry.slug, meta?.cwd),
        })
      }

      // Detach anything the user unchecked since the last poll.
      for (const sessionId of Array.from(attachedSessions.value.keys())) {
        if (!desired.has(sessionId))
          await detachSession(sessionId)
      }

      for (const [sessionId, entry] of desired) {
        if (attachedSessions.value.has(sessionId))
          continue
        try {
          await invokeAttachSessionBySlug({ sessionId, slug: entry.slug, tailOnly: true })
          attachedSessions.value.set(sessionId, entry)
        }
        catch {
          // Session file may have been deleted — skip and retry next poll.
        }
      }
    }
    catch {
      // Leave attached state unchanged on transient errors.
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined

  function stopPolling() {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  function startPolling(handler: () => void) {
    stopPolling()
    pollTimer = setInterval(handler, ALL_PROJECTS_POLL_MS)
  }

  async function reconcile() {
    const shouldAttach = enabled.value || showInChatHistory.value
    if (!shouldAttach) {
      stopPolling()
      hasCompletedInitialAllProjectsReconcile = false
      await detachAll()
      return
    }

    if (speechScope.value === 'all-projects-latest') {
      await reconcileAllProjectsLatest()
      startPolling(() => {
        void reconcileAllProjectsLatest()
      })
    }
    else if (speechScope.value === 'manual-select') {
      // Re-entering all-projects mode later should treat its next pass as
      // "first" again so we don't re-read stale history.
      hasCompletedInitialAllProjectsReconcile = false
      await reconcileManualSelect()
      startPolling(() => {
        void reconcileManualSelect()
      })
    }
    else {
      stopPolling()
      hasCompletedInitialAllProjectsReconcile = false
      await reconcileCurrentProject()
    }
  }

  onScopeDispose(() => {
    stopPolling()
    unsubscribe()
    if (chatHistoryFlushTimer !== undefined) {
      clearTimeout(chatHistoryFlushTimer)
      flushChatHistoryBuffer()
    }
  })

  watch(
    [enabled, showInChatHistory, projectDir, speechScope, selectedSessions],
    () => { void reconcile() },
    { immediate: true, deep: true },
  )

  return {
    enabled,
    projectDir,
    speechScope,
    attachedSessions,
    reconcile,
  }
}
