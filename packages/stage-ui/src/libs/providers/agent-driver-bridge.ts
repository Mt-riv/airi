import type {
  AgentMessage,
  DriverEvent,
  ModelDriver,
  StopReason,
  ToolDefinition,
} from '@proj-airi/agent-runtime'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { FinishReason, Message, Tool } from '@xsai/shared-chat'

import { errorMessageFrom } from '@moeru/std'
import { stepCountAtLeast } from '@xsai/shared-chat'
import { streamText } from '@xsai/stream-text'

export interface XsaiModelDriverOptions {
  model: string
  chatProvider: ChatProvider
  systemPrompt?: string
}

export function createXsaiModelDriver(options: XsaiModelDriverOptions): ModelDriver {
  return {
    stream(messages, tools, signal) {
      return streamFromProvider(options, messages, tools, signal)
    },
  }
}

function agentMessageToXsai(m: AgentMessage): Message {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.toolCallId ?? '',
    } as Message
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.callId,
        type: 'function',
        function: {
          name: tc.toolName,
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
        },
      })),
    } as unknown as Message
  }
  return { role: m.role, content: m.content } as Message
}

function toolDefinitionToXsai(def: ToolDefinition): Tool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
    },
    // NOTICE: xsai requires `execute` on every tool, but the harness owns
    // approval/sensitivity/cancellation of tool calls. We return an empty
    // string so xsai's step loop terminates cleanly after emitting tool-call
    // events. With `stopWhen: stepCountAtLeast(1)` the no-op result is never
    // fed back to the model.
    execute: () => '',
  }
}

function mapFinishReason(reason: FinishReason | string | undefined, hadToolCalls: boolean): StopReason {
  if (hadToolCalls)
    return 'tool_use'
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'end_turn'
    case 'tool_calls':
    case 'tool-calls':
      return 'tool_use'
    case 'length':
    case 'content_filter':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

async function* streamFromProvider(
  options: XsaiModelDriverOptions,
  messages: AgentMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): AsyncIterable<DriverEvent> {
  const chatConfig = options.chatProvider.chat(options.model)

  const xsaiMessages: Message[] = []
  if (options.systemPrompt) {
    xsaiMessages.push({ role: 'system', content: options.systemPrompt })
  }
  for (const m of messages) {
    xsaiMessages.push(agentMessageToXsai(m))
  }

  const xsaiTools = tools.length > 0 ? tools.map(toolDefinitionToXsai) : undefined

  const queue: DriverEvent[] = []
  let notify: (() => void) | null = null
  let done = false
  let finishEmitted = false
  let hadToolCalls = false
  let tokensIn: number | undefined
  let tokensOut: number | undefined

  const wake = () => {
    const n = notify
    notify = null
    n?.()
  }

  const push = (ev: DriverEvent) => {
    queue.push(ev)
    wake()
  }

  const finishStream = () => {
    done = true
    wake()
  }

  try {
    const streamResult = streamText({
      ...chatConfig,
      abortSignal: signal,
      messages: xsaiMessages,
      tools: xsaiTools,
      stopWhen: stepCountAtLeast(1),
      captureToolErrors: true,
      onEvent: (event) => {
        if (event.type === 'text-delta') {
          push({ kind: 'text-delta', text: event.text })
        }
        else if (event.type === 'reasoning-delta') {
          push({ kind: 'thinking-delta', text: event.text })
        }
        else if (event.type === 'tool-call') {
          hadToolCalls = true
          let input: unknown = {}
          const raw = (event.args ?? '') as unknown
          if (typeof raw === 'string' && raw.length > 0) {
            try {
              input = JSON.parse(raw)
            }
            catch {
              input = { __raw: raw }
            }
          }
          else if (raw && typeof raw === 'object') {
            input = raw
          }
          push({
            kind: 'tool-call-requested',
            callId: event.toolCallId,
            toolName: event.toolName,
            input,
          })
        }
        else if (event.type === 'finish') {
          finishEmitted = true
          tokensIn = event.usage?.prompt_tokens
          tokensOut = event.usage?.completion_tokens
          push({
            kind: 'finish',
            stopReason: mapFinishReason(event.finishReason, hadToolCalls),
            tokensIn,
            tokensOut,
          })
        }
        else if (event.type === 'error') {
          push({ kind: 'error', error: errorMessageFrom(event.error) ?? 'stream error' })
        }
      },
    })

    // NOTICE: Consume underlying promises to prevent unhandled rejections from
    // the xsai SSE parser and synthesize a `finish` event when xsai only emits
    // `tool-call` events (no `finish` in the tool-call branch of its step loop).
    streamResult.steps
      .then((steps) => {
        if (!finishEmitted) {
          const last = steps.at(-1)
          const usage = last?.usage
          push({
            kind: 'finish',
            stopReason: mapFinishReason(last?.finishReason, hadToolCalls),
            tokensIn: usage?.prompt_tokens,
            tokensOut: usage?.completion_tokens,
          })
        }
      })
      .catch((err) => {
        push({ kind: 'error', error: errorMessageFrom(err) ?? 'stream error' })
      })
      .finally(finishStream)

    // Silence auxiliary promises so they don't surface as unhandled rejections.
    void streamResult.messages.catch(() => {})
    void streamResult.usage.catch(() => {})
    void streamResult.totalUsage.catch(() => {})
  }
  catch (err) {
    push({ kind: 'error', error: errorMessageFrom(err) ?? 'stream error' })
    finishStream()
  }

  while (true) {
    while (queue.length > 0) {
      const ev = queue.shift()!
      yield ev
    }
    if (done)
      return
    await new Promise<void>((resolve) => {
      notify = resolve
    })
  }
}
