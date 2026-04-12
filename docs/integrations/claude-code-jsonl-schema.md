# Claude Code JSONL Session Schema

> **Audience**: Airi integrators bridging Claude Code CLI into the Airi chat window.
> **Claude Code version verified**: `2.1.96` (macOS, `/opt/homebrew/bin/claude`).
> **Status**: Phase 0 research artifact — see `PLAN.md` for integration progress.

Claude Code persists every TUI / headless session as an append-only JSONL file
under `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`. This document is
the ground-truth reference for mirroring those files into Airi.

---

## 1. Project slug convention

```
path.realpath(cwd).replace(/[/._]/g, '-')
```

- Every `/`, `_`, and `.` in the **real** working directory path becomes `-`,
  **including the leading slash**. Verified experimentally in Phase 0
  against Claude Code `2.1.96`.
- The path must be resolved via `fs.realpath` **before** hyphenation.
  macOS `/tmp` is a symlink to `/private/tmp`; running `claude` from `/tmp`
  writes to the slug `-private-tmp`, not `-tmp`.
- The transform is **lossy and ambiguous**: a directory literally named
  `project-sample` yields `…-project-sample`, indistinguishable from
  `project/sample`, `project.sample`, or `project_sample`. Airi must treat
  the slug strictly as a directory locator and use `sessionId` as the
  canonical identifier for a conversation.

### Verified examples

| Real cwd                                         | Slug                                            |
|--------------------------------------------------|-------------------------------------------------|
| `/Users/y_yamakawa/development/airi`             | `-Users-y-yamakawa-development-airi`            |
| `/private/tmp` (realpath of `/tmp`)              | `-private-tmp`                                  |
| `/private/tmp/airi_slug_test/a.b_c/d.e`          | `-private-tmp-airi-slug-test-a-b-c-d-e`         |

### Directory layout

```
~/.claude/projects/<slug>/
├── <session-uuid>.jsonl        ← tail this; one line = one event
├── <session-uuid>/             ← auxiliary tool-results / snapshots
│   ├── tool-results/           ← persisted large tool outputs
│   └── memory/
└── memory/                     ← project-level memory store
```

---

## 2. Two distinct JSONL dialects

Claude Code writes **two different event formats** depending on the transport:

| Source                              | File                                  | Dialect        |
|-------------------------------------|---------------------------------------|----------------|
| TUI session (interactive `claude`)  | `~/.claude/projects/<slug>/*.jsonl`   | **Transcript** |
| `claude -p --output-format stream-json` stdout | N/A (process stdout) | **Stream**     |

The transcript dialect is the historical, durable record. The stream dialect
is the live, delta-oriented protocol spoken over stdout by headless runs.
Airi needs to normalize both into its internal `StreamEvent` shape.

- **Mirror direction** (TUI → Airi) → parse **transcript** dialect.
- **Send direction** (Airi → Claude Code) → spawn `claude -p --resume <id>` and
  parse **stream** dialect from stdout, then rely on the transcript file for
  durable replay / other clients.

When `claude -p --resume <id>` runs, the same `<id>.jsonl` file under the
matching slug is **appended to**, not rewritten. Verified: file size grew from
47240 → 49096 bytes after a resume; the existing events stay intact and new
events are added at the tail.

---

## 3. Transcript dialect (durable JSONL)

### 3.1 Common envelope (every line)

```ts
interface TranscriptEnvelope {
  type: TranscriptEventType
  uuid: string // UUIDv4, unique per event
  parentUuid: string | null // previous event in the causal chain
  sessionId: string // matches the filename; stable for the file
  timestamp: string // ISO-8601 UTC
  cwd: string // realpath
  version: string // Claude Code version, e.g. "2.1.96"
  gitBranch?: string // optional
  entrypoint?: 'cli' | string
  userType?: 'external' | string
  isSidechain?: boolean // true inside spawned sub-agents
  isMeta?: boolean // true for synthetic/command events
  promptId?: string // shared across events from one user turn
  requestId?: string // Anthropic req_* id (assistant only)
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
}
```

`sessionId` is constant for every line in the file and equal to the filename
UUID. No event observed mid-file that rewrites it; resuming preserves it.

### 3.2 Observed `type` values

| type                    | meaning                                          | map → Airi `StreamEvent` |
|-------------------------|--------------------------------------------------|--------------------------|
| `user`                  | user turn (text OR array of `tool_result` blocks) | `text-delta` / `tool-result` |
| `assistant`             | model turn (`text` / `thinking` / `tool_use`)    | `text-delta` / `tool-call` |
| `system`                | diagnostics (hooks, local commands, API errors)  | `error` / meta            |
| `attachment`            | deferred tools / MCP instructions / skill listings | ignore (meta)           |
| `file-history-snapshot` | backup pointer for edited files                  | ignore (meta)            |
| `permission-mode`       | permission mode change                           | ignore (meta)            |
| `last-prompt`           | bookmark of the latest user prompt               | ignore (meta)            |
| `queue-operation`       | internal queue bookkeeping                       | ignore (meta)            |
| `create` / `update`     | file edit bookkeeping                            | ignore (meta)            |

> **Unknown type policy**: store as `{ type: 'unknown', raw }` to survive
> Claude Code version drift.

### 3.3 `user` event

```json
{
  "type": "user",
  "uuid": "b968d437-bf32-485a-a5b3-5f854a6c1e1c",
  "parentUuid": "bf652d1c-e925-4e27-b5d5-71a118f9edfe",
  "sessionId": "6a53894e-6c49-44b0-a804-62f0f382a2a7",
  "promptId": "28e8e057-039c-4d5a-8832-11fe09d746fc",
  "cwd": "/Users/y_yamakawa/development/airi",
  "version": "2.1.96",
  "gitBranch": "main",
  "timestamp": "2026-04-08T14:31:03.569Z",
  "permissionMode": "default",
  "message": {
    "role": "user",
    "content": "では、計画のフェーズ0から開始して…"
  }
}
```

`message.content` is **either** a string (plain prompt) **or** an array of
`tool_result` blocks in response to earlier `tool_use`s:

```json
{
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01QdaCuVaHyvmZfsZEfzpqeD",
        "content": "(Bash completed with no output)",
        "is_error": false
      }
    ]
  }
}
```

### 3.4 `assistant` event

```json
{
  "type": "assistant",
  "uuid": "822cf8c3-1839-4ccb-b59d-5957e4efb88f",
  "parentUuid": "019b8c8f-eb15-4883-aa24-5b1fd2472a0e",
  "requestId": "req_011CZrRHicGUkWRBTUKTGM3T",
  "sessionId": "96f94dfd-42df-468b-a7c8-e8d75655f035",
  "cwd": "/Users/y_yamakawa/development/airi",
  "timestamp": "2026-04-08T13:56:26.269Z",
  "message": {
    "role": "assistant",
    "id": "msg_019RJ9nREEFxvEs7pwgGcHFf",
    "model": "claude-opus-4-6",
    "type": "message",
    "stop_reason": "tool_use",
    "stop_sequence": null,
    "content": [
      { "type": "thinking", "thinking": "…", "signature": "Eq4JCmkI…" },
      { "type": "tool_use", "id": "toolu_01QdaCuVaHyvmZfsZEfzpqeD", "name": "Bash", "input": { "command": "ls", "description": "list" } },
      { "type": "text", "text": "Here is what I found." }
    ],
    "usage": {
      "input_tokens": 6,
      "cache_creation_input_tokens": 28788,
      "cache_read_input_tokens": 18748,
      "output_tokens": 503,
      "service_tier": "standard"
    }
  }
}
```

**Content block shapes**:

```ts
type AssistantContentBlock
  = | { type: 'text', text: string }
    | { type: 'thinking', thinking: string, signature: string }
    | { type: 'tool_use', id: string, name: string, input: Record<string, unknown>, caller?: unknown }
```

**Tool-call linkage**: an assistant `tool_use` block with `id = toolu_X` is
resolved by the next `user` message whose content array contains a
`tool_result` with `tool_use_id = toolu_X`.

### 3.5 `system` event

```json
{
  "type": "system",
  "subtype": "turn_duration" | "stop_hook_summary" | "local_command" | "api_error",
  "uuid": "…",
  "sessionId": "…",
  "parentUuid": "…",
  "timestamp": "…"
}
```

Observed subtypes with payloads:

- `turn_duration`: `{ durationMs: number, messageCount: number }`
- `stop_hook_summary`: `{ hookCount: number, hookInfos: Array<{ command, stdout, stderr, exitCode }> }`
- `local_command`: `{ content: string, level: 'info' | 'error' }`
- `api_error`: `{ error: { status, error: { type, message } }, retryInMs, retryAttempt, maxRetries }` — map to Airi `error`.

### 3.6 `attachment` event

Rendered as a `user`-typed envelope (because attachments accompany user turns)
with an extra `attachment` payload:

```json
{
  "type": "user",
  "attachment": {
    "type": "deferred_tools_delta" | "mcp_instructions_delta" | "skill_listing",
    "addedNames": ["…"],
    "addedBlocks": ["…"],
    "removedNames": []
  }
}
```

Treat as metadata; not surfaced to chat.

### 3.7 Sidechain behaviour

Every observed event had `isSidechain: false`. Sub-agent invocations
(`Task` tool) spawn into **separate** sessions — they do not appear inline in
the parent transcript. This simplifies Airi's consumer: one file = one
conversation thread.

---

## 4. Stream dialect (`claude -p --output-format stream-json`)

Captured by running:

```bash
claude -p "Say hi in 3 words" --output-format stream-json --verbose --include-partial-messages
```

Example sequence (trimmed):

```jsonl
{"type":"system","subtype":"hook_started","hook_id":"…","hook_name":"SessionStart:startup","session_id":"dbcbc764-…"}
{"type":"system","subtype":"hook_response","hook_id":"…","output":"…","stdout":"…","stderr":"…","exit_code":0,"outcome":"success","session_id":"dbcbc764-…"}
{"type":"system","subtype":"init","cwd":"/private/tmp","session_id":"dbcbc764-…","model":"claude-opus-4-6[1m]","permissionMode":"default","claude_code_version":"2.1.96","tools":[…],"mcp_servers":[…],"slash_commands":[…],"skills":[…],"plugins":[…]}
{"type":"stream_event","event":{…},"session_id":"dbcbc764-…","parent_tool_use_id":null,"uuid":"…"}
…  ← multiple stream_event deltas
{"type":"assistant","message":{"id":"msg_…","model":"claude-opus-4-6","content":[{"type":"text","text":"Hi there friend"}], "usage":{…}},"session_id":"dbcbc764-…","parent_tool_use_id":null,"uuid":"…"}
{"type":"rate_limit_event","rate_limit_info":{…},"session_id":"dbcbc764-…","uuid":"…"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":3333,"num_turns":1,"result":"Hi there friend","stop_reason":"end_turn","session_id":"dbcbc764-…","total_cost_usd":0.34,"usage":{…},"terminal_reason":"completed","uuid":"…"}
```

### 4.1 Event types (stream dialect)

| type              | description                                                       | map → Airi |
|-------------------|-------------------------------------------------------------------|------------|
| `system.init`     | **First line**: exposes `session_id`, `cwd`, `model`, tools, MCP servers. Capture `session_id` here to confirm `--resume`. | meta |
| `system.hook_*`   | `hook_started` / `hook_response` pairs wrapping hook runs.        | meta |
| `stream_event`    | Incremental model delta. Contains a nested `event` from the Anthropic Messages API streaming format (see below). | `text-delta` / `tool-call` delta |
| `assistant`       | Complete assistant message (same shape as transcript).            | `tool-call` (finalize) |
| `user`            | Tool result turn coming back.                                     | `tool-result` |
| `rate_limit_event`| `{ status, resetsAt, rateLimitType, overageStatus, overageResetsAt, isUsingOverage }` | meta |
| `result`          | **Last line**: turn finished. Carries `subtype: success \| error_*`, `is_error`, `duration_ms`, `result` (final text), `stop_reason`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `terminal_reason`. | `finish` |

### 4.2 `session_id` acquisition

- **Primary**: the first `system.init` line contains `session_id` and is
  emitted before the model starts generating. Airi's `SessionRunner` must
  capture it immediately so the UI can pin the conversation.
- **Secondary / fallback**: every subsequent line also carries `session_id`;
  newest JSONL file under the matching slug (by `mtime`) is the resume target.

### 4.3 `stream_event` inner shape

`stream_event.event` mirrors the Anthropic Messages API streaming events:

- `message_start` → contains the assistant message envelope.
- `content_block_start` → start of a `text`, `thinking`, or `tool_use` block.
- `content_block_delta` → `text_delta` / `thinking_delta` / `input_json_delta`.
- `content_block_stop` → end of a block.
- `message_delta` → usage / stop_reason updates.
- `message_stop` → message done.

Airi can map `text_delta` → `StreamEvent.text-delta`, and accumulate
`input_json_delta` until `content_block_stop` to emit a single `tool-call`.

---

## 5. Mapping to Airi `StreamEvent`

```ts
// packages/stage-ui/src/stores/llm.ts:18-24
type StreamEvent
  = | { type: 'text-delta', text: string }
    | { type: 'tool-call', toolCallId: string, toolName: string, args: unknown }
    | { type: 'tool-result', toolCallId: string, result: unknown }
    | { type: 'tool-error', toolCallId: string, error: string }
    | { type: 'finish', reason: string }
    | { type: 'error', error: string }
```

### Transcript → StreamEvent

| Transcript event                                            | StreamEvent emitted                         |
|-------------------------------------------------------------|---------------------------------------------|
| `user.message.content: string`                              | none (it's the user's own echo)             |
| `user.message.content[].tool_result` (`is_error: false`)    | `tool-result`                               |
| `user.message.content[].tool_result` (`is_error: true`)     | `tool-error`                                |
| `assistant.message.content[].text`                          | `text-delta` (whole text; one shot)         |
| `assistant.message.content[].thinking`                      | (optional) `text-delta` tagged as thinking  |
| `assistant.message.content[].tool_use`                      | `tool-call`                                 |
| `system.subtype: turn_duration`                             | `finish` (with `reason: 'turn_duration'`)   |
| `system.subtype: api_error`                                 | `error`                                     |
| `attachment` / `file-history-snapshot` / `permission-mode` / `last-prompt` / `queue-operation` / `create` / `update` | dropped |

### Stream → StreamEvent

| Stream event                                                                        | StreamEvent emitted                 |
|-------------------------------------------------------------------------------------|-------------------------------------|
| `system.init`                                                                       | metadata (expose `session_id`)      |
| `stream_event.event.content_block_delta.delta.type == 'text_delta'`                 | `text-delta`                        |
| `stream_event.event.content_block_delta.delta.type == 'thinking_delta'`             | (optional) `text-delta` (thinking)  |
| `stream_event.event.content_block_delta.delta.type == 'input_json_delta'`           | buffer until `content_block_stop`   |
| `stream_event.event.content_block_stop` for a `tool_use` block                      | `tool-call`                         |
| `assistant` (full)                                                                  | dedupe vs streamed deltas           |
| `user` (with `tool_result`)                                                         | `tool-result` / `tool-error`        |
| `result` (`subtype: success`)                                                       | `finish` (`reason: stop_reason`)    |
| `result` (`is_error: true`)                                                         | `error`                             |

**Dedupe rule**: streamed `text-delta`s concatenate into the same logical
message that the later full `assistant` event represents — Airi should not
re-emit the full text if the deltas already covered it. Use the assistant
`message.id` (when the live feed starts with `message_start`) as the
reconciliation key.

---

## 6. `--resume` semantics (verified)

- Command: `claude --resume <session-uuid> -p "<prompt>" --output-format stream-json --verbose`.
- The existing `~/.claude/projects/<slug>/<session-uuid>.jsonl` file is
  **appended to**; previous events remain intact.
- The stream dialect still emits `session.init.session_id = <session-uuid>`
  and new `system.subtype: init` is added to the transcript.
- Resume works across cwd: running resume from any cwd targets the slug that
  owns the file. Airi should therefore **locate the JSONL by session UUID**,
  not by cwd.
- Cross-tool safety: the TUI and the headless runner can resume the same file
  but not simultaneously without coordination. Airi's `ClaudeCodeService` will
  serialize send operations per session.

---

## 7. Security notes for Airi

1. **Command injection**: pass `prompt`, `sessionId`, `projectDir` as `execa`
   arguments (array form), never interpolate into a shell string. Enforce
   `shell: false`.
2. **Path escape**: resolve `projectDir` with `fs.realpath` and confirm it is
   a directory before deriving the slug. Reject paths containing NUL bytes.
3. **JSONL line size**: observed lines > 130 kB in transcripts. Use a
   streaming line splitter with no per-line buffer cap — or a generous one
   (≥ 4 MB).
4. **File permissions**: `~/.claude/projects/<slug>` is mode `700`. Airi runs
   under the same user, so no extra handling required; do not copy or ship
   the files outside the user's home without consent.

---

## 8. Open questions / follow-ups

- `caller` field on `tool_use` blocks was observed occasionally; shape
  undocumented upstream. Treat as unknown and pass through.
- `stream_event.event` emitted with `event:"dict"` when verbose mode elides
  the body; the live JSON in stdout includes the full nested structure. Our
  agent ran `head -200` which truncated lines; POC script below captures the
  raw bytes for future reference.
- Whether `stop_reason: 'pause_turn'` / partial interruption triggers a
  distinct dialect is unverified — observed only `end_turn` so far.
