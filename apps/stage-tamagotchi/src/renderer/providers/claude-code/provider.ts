import type { StreamEvent, StreamOptions } from '@proj-airi/stage-ui/stores/llm'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type {
  ClaudeCodeCheckBinaryInput,
  ClaudeCodeCheckBinaryResult,
  ClaudeCodeResolveSlugInput,
  ClaudeCodeResolveSlugResult,
  ClaudeCodeSendPromptInput,
  ClaudeCodeSendPromptResult,
  ClaudeCodeStreamEventPayload,
  NormalizedClaudeCodeEvent,
} from '../../../shared/claude-code'
import type { ClaudeCodeConfigParsed } from './config'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import {
  claudeCodeCheckBinary,
  claudeCodeResolveSlug,
  claudeCodeSendPrompt,
  claudeCodeStreamEvent,
} from '../../../shared/eventa'

// Shape the llm-store duck-typing check looks for. Keep the property name
// in sync with `isClaudeCodeChatProvider` in
// `packages/stage-ui/src/stores/llm.ts`.
export const CLAUDE_CODE_STREAM_METHOD = '__airi_claudeCodeStream' as const

export type ClaudeCodeStreamMethod = (
  messages: Message[],
  options?: StreamOptions,
) => Promise<void>

export type ClaudeCodeChatProvider = ChatProvider & {
  [CLAUDE_CODE_STREAM_METHOD]: ClaudeCodeStreamMethod
}

// Hook for tests: injects the Eventa context + invoke factory so we can
// verify the bridge without touching real IPC. In production the defaults
// resolve to the shared renderer eventa context.
export interface ClaudeCodeTransport {
  sendPrompt: (payload: ClaudeCodeSendPromptInput) => Promise<ClaudeCodeSendPromptResult>
  /**
   * Set the active stream event callback. Only ONE callback is active at a
   * time — calling this replaces the previous one. Pass `null` to stop
   * receiving events. The transport registers its IPC listener ONCE at
   * creation time and routes incoming events to the current callback,
   * avoiding the subscribe/unsubscribe pattern that leaks listeners when
   * the Eventa renderer adapter doesn't properly remove `ipcRenderer.on`
   * handlers.
   */
  setStreamCallback: (callback: ((payload: ClaudeCodeStreamEventPayload) => void) | null) => void
  checkBinary: (payload: ClaudeCodeCheckBinaryInput) => Promise<ClaudeCodeCheckBinaryResult>
  resolveSlug: (payload: ClaudeCodeResolveSlugInput) => Promise<ClaudeCodeResolveSlugResult>
}

export function createDefaultTransport(): ClaudeCodeTransport {
  const context = getElectronEventaContext()
  const invokeSendPrompt = defineInvoke(context, claudeCodeSendPrompt)
  const invokeCheckBinary = defineInvoke(context, claudeCodeCheckBinary)
  const invokeResolveSlug = defineInvoke(context, claudeCodeResolveSlug)

  // Single persistent IPC listener — registered ONCE at transport creation.
  // The active callback is swapped per-message via `setStreamCallback` so we
  // never accumulate leaked `ipcRenderer.on` handlers (the Eventa renderer
  // adapter's unsubscribe may not reliably remove them).
  let activeCallback: ((payload: ClaudeCodeStreamEventPayload) => void) | null = null

  context.on(claudeCodeStreamEvent, (raw) => {
    if (activeCallback == null)
      return

    try {
      if (raw == null || typeof raw !== 'object')
        return

      const envelope = raw as unknown as Record<string, unknown>
      const inner = (envelope.body != null && typeof envelope.body === 'object'
        ? envelope.body
        : envelope) as Record<string, unknown>

      const sessionId = typeof inner.sessionId === 'string' ? inner.sessionId : ''
      const event = inner.event as NormalizedClaudeCodeEvent | undefined

      if (event != null && typeof event === 'object' && 'kind' in event) {
        activeCallback({ sessionId, event })
      }
    }
    catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[claude-code] stream event parse error:', error)
    }
  })

  return {
    sendPrompt: payload => invokeSendPrompt(payload),
    setStreamCallback: (callback) => {
      activeCallback = callback
    },
    checkBinary: payload => invokeCheckBinary(payload),
    resolveSlug: payload => invokeResolveSlug(payload),
  }
}

function lastUserMessageText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'user')
      continue
    const { content } = message
    if (typeof content === 'string')
      return content
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (!part || typeof part !== 'object')
            return ''
          if ((part as { type?: string }).type === 'text')
            return (part as { text?: string }).text ?? ''
          return ''
        })
        .join('')
      if (text.length > 0)
        return text
    }
  }
  return ''
}

function normalisedEventToStreamEvent(
  event: NormalizedClaudeCodeEvent,
): StreamEvent | null {
  switch (event.kind) {
    case 'assistant-text':
      return { type: 'text-delta', text: event.text }
    case 'assistant-thinking':
      // NOTICE: Airi's stream-store does not have a thinking slice yet.
      //         Surface the thinking block as a plain text delta for now;
      //         Phase 5 can split it into its own UI affordance.
      return { type: 'text-delta', text: event.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      } as unknown as StreamEvent
    case 'tool-result':
      if (event.isError) {
        return {
          type: 'tool-error',
          toolCallId: event.toolCallId,
          result: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
        } as unknown as StreamEvent
      }
      return {
        type: 'tool-result',
        toolCallId: event.toolCallId,
        result: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
      }
    case 'finish':
      return { type: 'finish', finishReason: event.reason } as StreamEvent
    case 'error':
      return { type: 'error', error: new Error(event.error) }
    case 'user-text':
    case 'meta':
    case 'unknown':
      return null
    default: {
      // Exhaustiveness guard — TS will error if we ever extend
      // NormalizedClaudeCodeEvent without handling the new kind here.
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

export interface CreateClaudeCodeStreamDispatcherOptions {
  config: ClaudeCodeConfigParsed
  transport?: ClaudeCodeTransport
}

// Stateful dispatcher — one per provider instance. Remembers the active
// session id across multiple send calls so follow-up prompts resume the
// same Claude Code session instead of spawning a new one each turn.
export function createClaudeCodeStreamDispatcher(
  options: CreateClaudeCodeStreamDispatcherOptions,
): ClaudeCodeStreamMethod {
  const transport = options.transport ?? createDefaultTransport()
  let currentSessionId: string | null = options.config.sessionId ?? null

  // UUID-based deduplication set. Cleared per-message so it doesn't grow
  // unboundedly across a long session. This is the definitive guard against
  // duplicate events regardless of their source — `--include-partial-messages`
  // partial snapshots, Eventa adapter IPC replays, or multi-window broadcast
  // races.
  const seenUuids = new Set<string>()

  return async function streamClaudeCode(messages, streamOptions) {
    seenUuids.clear()
    // eslint-disable-next-line no-console
    console.log('[claude-code] streamClaudeCode invoked', { messageCount: messages.length, currentSessionId })

    const text = lastUserMessageText(messages)
    if (text.length === 0) {
      // eslint-disable-next-line no-console
      console.warn('[claude-code] empty prompt, emitting no_input finish')
      // Nothing actionable — emit a no-op finish so the orchestrator
      // unwinds cleanly.
      await streamOptions?.onStreamEvent?.({ type: 'finish', finishReason: 'no_input' } as StreamEvent)
      return
    }

    let receivedEventCount = 0

    // Activate the stream callback before sending so early stdout events
    // cannot race past us. Only ONE callback is active at a time — the
    // transport routes all incoming IPC events to it.
    transport.setStreamCallback((payload) => {
      receivedEventCount += 1

      // UUID-based dedup — skip events we've already processed.
      const eventUuid = payload.event.uuid
      if (eventUuid && seenUuids.has(eventUuid)) {
        // eslint-disable-next-line no-console
        console.log('[claude-code] DEDUP skip uuid:', eventUuid.slice(0, 8), 'kind:', payload.event.kind)
        return
      }
      if (eventUuid) {
        seenUuids.add(eventUuid)
      }

      // Once we know the session id, filter tightly.
      if (currentSessionId != null && payload.sessionId !== currentSessionId)
        return

      const streamEvent = normalisedEventToStreamEvent(payload.event)
      if (streamEvent == null)
        return

      // eslint-disable-next-line no-console
      console.log('[claude-code] PASS uuid:', eventUuid?.slice(0, 8), 'kind:', payload.event.kind, 'text:', (streamEvent as { text?: string }).text?.slice(0, 20))
      void streamOptions?.onStreamEvent?.(streamEvent)
    })

    try {
      // eslint-disable-next-line no-console
      console.log('[claude-code] sending prompt via IPC', { projectDir: options.config.projectDir, sessionId: currentSessionId, textLength: text.length })

      const result = await transport.sendPrompt({
        projectDir: options.config.projectDir,
        sessionId: currentSessionId,
        text,
      })

      // eslint-disable-next-line no-console
      console.log('[claude-code] sendPrompt result', { ...result, receivedEventCount })

      if (result.ok) {
        if (result.sessionId != null)
          currentSessionId = result.sessionId

        // NOTICE: The runner surfaces its own `finish` event via the normal
        //         stream path, but we also emit one here to guarantee the
        //         chat orchestrator's waitForTools loop unwinds even if the
        //         transcript lacked a `turn_duration` meta.
        await streamOptions?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' } as StreamEvent)
        return
      }

      if (result.sessionId != null)
        currentSessionId = result.sessionId

      await streamOptions?.onStreamEvent?.({
        type: 'error',
        error: new Error(result.error),
      })
      throw new Error(result.error)
    }
    finally {
      transport.setStreamCallback(null)
    }
  }
}

/**
 * Build a `ChatProvider`-compatible shim. The `.chat(model)` config is a
 * placeholder — it is never consumed because `llmStore.stream` intercepts
 * the request via `isClaudeCodeChatProvider` and delegates to
 * `__airi_claudeCodeStream`.
 */
export function createClaudeCodeProvider(
  config: ClaudeCodeConfigParsed,
  transport?: ClaudeCodeTransport,
): ClaudeCodeChatProvider {
  const streamMethod = createClaudeCodeStreamDispatcher({ config, transport })

  const chatConfig = (model: string) => ({
    baseURL: 'claude-code-ipc://noop/',
    apiKey: '',
    headers: {},
    model,
  })

  const shim = {
    chat: chatConfig,
    [CLAUDE_CODE_STREAM_METHOD]: streamMethod,
  } satisfies ClaudeCodeChatProvider

  return shim
}
