import type { AllowList } from './sensitivity'
import type { AgentMessage, ApprovalGate, AttemptResult, ModelDriver, RunAttemptParams, StopReason, ToolCallRequest, ToolInvoker } from './types'

import { errorMessageFrom } from '@moeru/std'

import { isAbortError } from './abort'
import { handleToolCall } from './tool-loop'

const DEFAULT_MAX_TOOL_CALLS = 20

export interface RunAttemptDeps {
  modelDriver: ModelDriver
  toolInvoker: ToolInvoker
  approvalGate: ApprovalGate
  allowList?: AllowList
}

export async function runAttempt(
  params: RunAttemptParams,
  deps: RunAttemptDeps,
): Promise<AttemptResult> {
  const { turn, onPartialReply, onAgentEvent, signal } = params
  const { modelDriver, toolInvoker, approvalGate, allowList } = deps
  const maxToolCalls = params.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS

  const startMs = Date.now()

  const messages: AgentMessage[] = [...turn.messages]

  let toolCallCount = 0
  let tokensIn: number | undefined
  let tokensOut: number | undefined
  let finalStopReason: StopReason = 'end_turn'

  try {
    while (true) {
      if (signal.aborted) {
        finalStopReason = 'aborted'
        break
      }

      let hasOutput = false
      const pendingToolCalls: ToolCallRequest[] = []
      let streamStopReason: StopReason = 'end_turn'

      const stream = modelDriver.stream(messages, turn.tools, signal)

      for await (const event of stream) {
        if (signal.aborted) {
          finalStopReason = 'aborted'
          break
        }

        if (event.kind === 'text-delta' || event.kind === 'thinking-delta') {
          if (event.text.length === 0) {
            continue
          }
          hasOutput = true
          onPartialReply(event)
        }
        else if (event.kind === 'tool-call-requested') {
          pendingToolCalls.push({
            callId: event.callId,
            toolName: event.toolName,
            input: event.input,
          })
        }
        else if (event.kind === 'finish') {
          streamStopReason = event.stopReason
          if (event.tokensIn !== undefined) {
            tokensIn = (tokensIn ?? 0) + event.tokensIn
          }
          if (event.tokensOut !== undefined) {
            tokensOut = (tokensOut ?? 0) + event.tokensOut
          }
        }
        else if (event.kind === 'error') {
          throw new Error(event.error)
        }
      }

      if (signal.aborted) {
        finalStopReason = 'aborted'
        break
      }

      if (!hasOutput && pendingToolCalls.length === 0 && streamStopReason === 'end_turn') {
        finalStopReason = 'no_output'
        break
      }

      if (pendingToolCalls.length === 0) {
        finalStopReason = streamStopReason
        break
      }

      // Slice to the remaining budget so the assistant record reflects only
      // tool calls we actually dispatch.
      const budget = Math.max(0, maxToolCalls - toolCallCount)
      const dispatched = pendingToolCalls.slice(0, budget)
      const capped = dispatched.length < pendingToolCalls.length

      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: dispatched,
      })

      for (const tc of dispatched) {
        if (signal.aborted) {
          finalStopReason = 'aborted'
          break
        }

        let toolOutput: unknown
        try {
          const result = await handleToolCall({
            callId: tc.callId,
            toolName: tc.toolName,
            input: tc.input,
            toolInvoker,
            approvalGate,
            allowList,
            onAgentEvent,
            signal,
          })
          toolOutput = result.output
        }
        catch (err) {
          if (signal.aborted || isAbortError(err)) {
            finalStopReason = 'aborted'
            break
          }
          toolOutput = { error: errorMessageFrom(err) }
        }

        toolCallCount++

        messages.push({
          role: 'tool',
          content: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput),
          toolCallId: tc.callId,
          toolName: tc.toolName,
        })
      }

      if (finalStopReason === 'aborted') {
        break
      }

      if (capped) {
        finalStopReason = 'max_tool_calls'
        break
      }
    }
  }
  catch (err) {
    if (signal.aborted || isAbortError(err)) {
      finalStopReason = 'aborted'
    }
    else {
      finalStopReason = 'error'
      onAgentEvent({ kind: 'turn-finished', stopReason: finalStopReason })
      throw err
    }
  }

  const elapsedMs = Date.now() - startMs

  onAgentEvent({ kind: 'turn-finished', stopReason: finalStopReason })

  return {
    stopReason: finalStopReason,
    toolCalls: toolCallCount,
    tokensIn,
    tokensOut,
    elapsedMs,
  }
}
