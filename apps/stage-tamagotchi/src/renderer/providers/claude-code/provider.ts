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
  onStreamEvent: (listener: (payload: ClaudeCodeStreamEventPayload) => void) => () => void
  checkBinary: (payload: ClaudeCodeCheckBinaryInput) => Promise<ClaudeCodeCheckBinaryResult>
  resolveSlug: (payload: ClaudeCodeResolveSlugInput) => Promise<ClaudeCodeResolveSlugResult>
}

export function createDefaultTransport(): ClaudeCodeTransport {
  const context = getElectronEventaContext()
  const invokeSendPrompt = defineInvoke(context, claudeCodeSendPrompt)
  const invokeCheckBinary = defineInvoke(context, claudeCodeCheckBinary)
  const invokeResolveSlug = defineInvoke(context, claudeCodeResolveSlug)

  return {
    sendPrompt: payload => invokeSendPrompt(payload),
    onStreamEvent: (listener) => {
      return context.on(claudeCodeStreamEvent, (payload) => {
        if (payload)
          // NOTICE: `context.on` types the handler as receiving the event
          //         definition itself (`Eventa<P, ...>`); in practice the
          //         renderer adapter forwards the decoded `P` payload. Cast
          //         through `unknown` to bridge the declared shape.
          listener(payload as unknown as ClaudeCodeStreamEventPayload)
      })
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

  return async function streamClaudeCode(messages, streamOptions) {
    const text = lastUserMessageText(messages)
    if (text.length === 0) {
      // Nothing actionable — emit a no-op finish so the orchestrator
      // unwinds cleanly.
      await streamOptions?.onStreamEvent?.({ type: 'finish', finishReason: 'no_input' } as StreamEvent)
      return
    }

    // Subscribe before sending so early stdout events cannot race past us.
    const unsubscribe = transport.onStreamEvent((payload) => {
      // Once we know the session id, filter tightly. Before that, forward
      // anything the transport delivers (there is only one active runner
      // so spurious cross-talk is not a concern in Phase 3).
      if (currentSessionId != null && payload.sessionId !== currentSessionId)
        return

      const streamEvent = normalisedEventToStreamEvent(payload.event)
      if (streamEvent == null)
        return

      void streamOptions?.onStreamEvent?.(streamEvent)
    })

    try {
      const result = await transport.sendPrompt({
        projectDir: options.config.projectDir,
        sessionId: currentSessionId,
        text,
      })

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
      unsubscribe()
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
