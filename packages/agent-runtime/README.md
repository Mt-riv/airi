# @proj-airi/agent-runtime

Platform-agnostic agent harness core for AIRI. Provides the run-attempt loop, tool-call loop, abort/reset utilities, an interactive approval gate, a minimal event bus, and Valibot schemas — with **zero dependencies on Electron, Vue, or any specific model provider**.

## What it does

- **`createAgentHarness`** — factory that wires a `ModelDriver`, `ToolInvoker`, and `ApprovalGate` into an `AgentHarness` that drives full agent turns.
- **`runAttempt`** — drives a single agent turn: streams from the model, forwards `text-delta`/`thinking-delta` chunks, delegates tool calls (with sensitivity evaluation and optional approval), enforces a max-tool-calls guard, and returns an `AttemptResult`.
- **`handleToolCall`** — single tool call lifecycle: sensitivity check → approval gate → invoke → emit events. Honors `AbortSignal` at every await.
- **`evaluateSensitivity`** — pure function that classifies tool names as sensitive (`exec`, `shell`, `filesystem.write`, `network.*`) with allow-list support.
- **`createInteractiveApprovalGate`** — production-grade `ApprovalGate` that emits each `ApprovalRequest` to a UI callback and waits for `approve/reject` via the returned `resolve` handle. Supports per-request `AbortSignal` cancellation and an optional `timeoutMs` fallback.
- **`linkAbortSignals`** — combines multiple `AbortSignal`s into one; aborts when any of them fires.
- **`createResetController`** — session-level reset signal with replaceable inner controller.
- **`createAgentEventBus`** — minimal mitt-style typed pub/sub; listener exceptions are isolated and logged.
- **`runAttemptParamsSchema` / `agentEventSchema`** — Valibot schemas for the two core types.

## How to use

```ts
import {
  createAgentHarness,
  createInteractiveApprovalGate,
} from '@proj-airi/agent-runtime'

const gate = createInteractiveApprovalGate({
  emit: req => ui.showApprovalModal(req),
  onSettled: id => ui.dismissApprovalModal(id),
  timeoutMs: 60_000,
})

const harness = createAgentHarness({ modelDriver, toolInvoker, approvalGate: gate })

const result = await harness.runAttempt({
  turn: { messages, tools },
  onPartialReply: chunk => ui.stream(chunk),
  onAgentEvent: event => bus.emit(event),
  signal: abortController.signal,
})

// From the UI after the user acts:
gate.resolve(request.id, { approved: true })
```

## When to use

- Anywhere you need a complete, testable agent turn loop without pulling in Electron or Vue dependencies.
- As the core logic unit behind the Electron main-process agent service and the renderer-side harness wrapper.
- In unit tests that need to exercise full turn/tool-call behavior with mock drivers.

## When NOT to use

- Do not import this package from Vue components directly — use the Pinia store / composables in `packages/stage-ui` (e.g. `useAgentRuntimeStore`, `useAgentApproval`) that wrap it.
- Do not use this to implement model-specific streaming logic — that belongs in the `ModelDriver` implementation.
- Do not use this for UI-layer event routing — use Eventa or Pinia for that bridge.
