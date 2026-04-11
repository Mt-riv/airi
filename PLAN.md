# Claude Code × Airi 統合 実装計画

> **目的**: ~~Airi のチャットウインドウを Claude Code CLI のフロントエンドとして機能させる。~~
> **方針転換 (2026-04-11)**: チャットウインドウ統合を撤回。代わりに **Airi のキャラクターアバターが Claude Code の応答を読み上げる** パッシブ監視方式に変更。参考実装: [cc-mascot](https://github.com/kazakago/cc-mascot)
>
> **新しい目的**:
> 1. Claude Code の JSONL セッションログをファイル監視し、assistant 応答テキストを抽出
> 2. テキストから Markdown / コードブロック / URL を除去
> 3. Airi 既存の TTS パイプライン (`characterStore.emitTextOutput`) に流し、VRM キャラクターが口パクで読み上げ
>
> **対象**: `apps/stage-tamagotchi` (Electron) のみ。
> **方針**: JSONL tail によるパッシブ監視。Claude Code 側の設定変更不要、コンテキスト消費ゼロ。
> **開始日**: 2026-04-08
> **最終更新**: 2026-04-11

---

## 進捗ダッシュボード

### 旧フェーズ（チャットウインドウ統合 — 撤回）

| Phase | 概要 | 状態 | 完了日 | 備考 |
|---|---|---|---|---|
| Phase 0 | リサーチ検証 & POC | ✅ 完了 | 2026-04-08 | JSONL スキーマ確定 — **新方針でも有効** |
| Phase 1 | SessionWatcher / normalizer | ✅ 完了 | 2026-04-09 | **新方針の核心インフラとして継続使用** |
| Phase 2 | Eventa IPC コントラクト | ✅ 完了 | 2026-04-09 | **streamEvent broadcast を継続使用** |
| Phase 3 | Chat Provider 登録 | ❌ 撤回 | 2026-04-09 | llm.ts 分岐 + provider → 削除対象 |
| Phase 4 | i18n | ✅ 完了 | 2026-04-09 | 設定ページ用キーは残す |
| Phase 5 | UI: 設定 & バリデータ | 🟨 部分完了 | 2026-04-09 | checkBinary / resolveSlug は残す |
| Phase 6 | テスト & 品質 | 🟨 部分完了 | 2026-04-09 | 統合テスト + カバレッジ 86.66% |
| Phase 7 | ドキュメント | ⬜ 未着手 | — | |

### 新フェーズ（読み上げモード）

| Phase | 概要 | 状態 | 完了日 | 備考 |
|---|---|---|---|---|
| New-1 | Cleanup + TextFilter | ✅ 完了 | 2026-04-11 | chat provider 削除 + textFilter 31 tests |
| New-2 | Speech Bridge + 設定簡素化 | ⬜ 未着手 | — | watcher → emitTextOutput 接続 |
| New-3 | 統合テスト + 検証 | ⬜ 未着手 | — | dev build で読み上げ動作確認 |

**状態凡例**: ⬜ 未着手 / 🟨 進行中 / ✅ 完了 / ❌ 撤回 / 🟥 ブロック

---

## アーキテクチャ

```
┌─────────────────────── Airi Electron ────────────────────────┐
│  Renderer (Vue / stage-ui)                                   │
│    ChatHistory ← streamStore ← chatOrchestrator.ingest()    │
│                                     │                        │
│                              ClaudeCodeProvider (新規)       │
│                                     │ Eventa                 │
│  Main process                       ▼                        │
│   ┌─────────────────────────────────────────────────────┐    │
│   │ ClaudeCodeService (injeca)                          │    │
│   │  ├─ SessionWatcher : JSONL tail (chokidar)          │◀───┼── ~/.claude/projects/<slug>/*.jsonl
│   │  │    → JSONL→StreamEvent変換                       │    │      (TUIセッションをミラー)
│   │  ├─ SessionRunner  : child_process(claude -p       │───▶┼── Claude Code CLI
│   │  │     --output-format stream-json --resume <id>    │    │      (Airiからのプロンプト送信)
│   │  │     --include-partial-messages)                  │    │
│   │  └─ HookHTTPServer : localhost 受け口 (任意)        │◀───┼── hooks設定でPOST転送
│   └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### データフロー
1. **ミラー方向** (Claude Code TUI → Airi)
   - `SessionWatcher` が `~/.claude/projects/<slug>/*.jsonl` を tail
   - 各行を `jsonl-to-stream-event.ts` で正規化 `StreamEvent` に変換
   - Eventa `claudeCodeStreamEvent` で renderer にブロードキャスト
   - `ClaudeCodeProvider` が受信 → `stream-store.appendStreamLiteral()` / `tool-call` slice 追加

2. **送信方向** (Airi → Claude Code)
   - ユーザー入力 → `chatOrchestrator.ingest()` → `ClaudeCodeProvider.message()`
   - Eventa `claudeCodeSendPrompt` invoke
   - Main 側 `SessionRunner` が `execa` で `claude -p "<text>" --resume <id> --output-format stream-json` を spawn
   - stdout を行単位で parse → 同じく `claudeCodeStreamEvent` で配信

### 重要な発見（研究フェーズより）
- **Airi チャット UI は既に tool-call 描画器を持つ** (`packages/stage-ui/src/components/scenarios/chat/tool-call-block.vue`)。Claude Code の `Bash`/`Read`/`Edit` 等の tool_name を渡すだけで描画される。
- **`ChatSlices` 型** (`packages/stage-ui/src/types/chat.ts`) は `text | tool-call | tool-call-result` の union で Claude Code のイベントに 1:1 対応可能。
- **`StreamEvent`** (`packages/stage-ui/src/stores/llm.ts:18-24`): `text-delta | tool-call | tool-result | tool-error | finish | error` → Claude Code JSONL から直接マップ可能。
- **既存 MCP subprocess パターン** (`apps/stage-tamagotchi/src/main/services/airi/mcp-servers/index.ts`) が `StdioClientTransport` で子プロセスを spawn 済み → ClaudeCodeService のテンプレにできる。

---

## Phase 0: リサーチ検証 & POC

**目的**: Claude Code の実 JSONL スキーマと `--resume` の挙動を確定する。
**成果物**: `docs/integrations/claude-code-jsonl-schema.md`

### タスク
- [x] `ls ~/.claude/projects/` で既存プロジェクト slug を確認
- [x] 代表的な JSONL ファイルを 1 件読み、event 型を列挙（`user` / `assistant` / `tool_use` / `tool_result` / `summary` / etc.）
- [x] `claude -p "hi" --output-format stream-json --verbose --include-partial-messages` を実行し stdout を記録
- [x] `claude --resume <既存id> -p "追記"` で既存セッションに追記できるか検証
- [x] セッション ID の取得方法（headless stdout の system イベント / JSONL ファイル名）を確定
- [x] Claude Code バイナリのバージョン記録（`claude --version`）
- [x] `docs/integrations/claude-code-jsonl-schema.md` に JSONL イベント型の TypeScript interface を記述
- [x] `scripts/poc/claude-code-tail.mjs` で JSONL tail → 整形表示の最小 POC（確認後破棄可）

### チェック項目
- [x] `claude` バイナリが PATH にある（`which claude` → `/opt/homebrew/bin/claude`, v2.1.96）
- [x] `execa` が `@proj-airi/stage-tamagotchi` の dependencies に含まれるか確認（**未導入** — Phase 1 で追加）
- [x] `chokidar` が dependencies に含まれるか確認（**未導入** — Phase 1 で追加）

### 実績ログ

**2026-04-08 — Phase 0 完了**

**検証した環境**
- Claude Code バイナリ: `/opt/homebrew/bin/claude` (v2.1.96)
- ホスト OS: macOS (darwin 25.3.0)
- 既存プロジェクト slug 7 件（`-Users-y-yamakawa-development-airi` を含む）

**主要な発見事項**
1. **Project slug は `/` / `_` / `.` を全て `-` に変換する歪曲写像**（lossy）。
   - `/Users/y_yamakawa/development/airi` → `-Users-y-yamakawa-development-airi`
   - `/private/tmp/airi_slug_test/a.b_c/d.e` → `-private-tmp-airi-slug-test-a-b-c-d-e`
   - `/tmp` は symlink → `/private/tmp` → `-private-tmp`（**realpath 解決が必須**）
   - 元来のディレクトリ名は復元不能。Airi は slug を「ディレクトリの位置特定」にのみ使い、`sessionId` を canonical ID として扱う。
2. **JSONL には 2 つの dialect** が存在する:
   - **Transcript**（`~/.claude/projects/<slug>/*.jsonl`）: 永続的な append-only 履歴。TUI / 全セッションの記録元。
   - **Stream**（`claude -p --output-format stream-json` の stdout）: 送信操作時のリアルタイム protocol（`system.init` / `stream_event` / `assistant` / `result` 等）。
3. **Transcript dialect の top-level `type`** を網羅:
   `user` / `assistant` / `system` / `attachment` / `file-history-snapshot` / `permission-mode` / `last-prompt` / `queue-operation` / `create` / `update`。
4. **Assistant content block**: `text` / `thinking` / `tool_use`（`{id, name, input}`）。
5. **User content block**: string もしくは `tool_result` ブロックの配列（`tool_use_id` で linkage）。
6. **System subtype**: `turn_duration` / `stop_hook_summary` / `local_command` / `api_error` / `hook_started` / `hook_response` / `init`。
7. **Stream dialect の session_id 取得**: 最初の `{type:"system",subtype:"init"}` 行に即時で `session_id` が出る → `SessionRunner` はこの行をキャプチャしてセッションを確定できる。
8. **`--resume` の振る舞い**: 既存 `<id>.jsonl` に **append** される（47240→49096 bytes で実測）。`session_id` は維持される。
9. **sidechain（Task tool）**: 今回観測したイベントは全て `isSidechain: false`。サブエージェントは別ファイルに独立したセッションとして書かれる。
10. **Airi `StreamEvent` へのマッピング**が 1:1 で定義可能（`docs/integrations/claude-code-jsonl-schema.md §5` 参照）。

**成果物**
- `docs/integrations/claude-code-jsonl-schema.md` — 完全なスキーマリファレンス（transcript / stream 両 dialect、StreamEvent マッピング、セキュリティ注意点を含む）。
- `scripts/poc/claude-code-tail.mjs` — 依存ゼロの POC。実セッションファイルを tail して全 event 型を整形出力（動作確認済み）。

**Phase 1 への申し送り**
- **依存追加が必要**: `execa` / `chokidar` いずれも airi workspace 未導入。`apps/stage-tamagotchi/package.json` に追加する（執筆時点で既存の子プロセス spawn 箇所は `@modelcontextprotocol/sdk` の `StdioClientTransport` 経由なので参考にならない）。
- **`project-slug.ts`** の変換ルールは `realpath(dir).replace(/[/._]/g, '-')`。ただし逆変換は不可能なので、Airi 側の canonical identifier は常に `sessionId` に置く。
- **`SessionWatcher`** はファイル size の差分のみを読む cursor 型で実装すると race condition に強い（POC で採用した node:fs.watch + cursor パターン）。chokidar に移行しても同じ cursor ロジックを流用できる。
- **`SessionRunner`** は stdout 第1行（`system.init`）で `session_id` を確定し、それ以降は `stream_event` を accumulate、`result` で `finish` emit。`--resume` 時も同じ流れ。
- **Unknown type 退避策** (R3 対応): `{type:'unknown', raw}` に wrap して落とさない。
- **セキュリティ**: `execa` の配列形式 + `shell:false`、`fs.realpath` + NUL byte 拒否で R6/R7 の大半をカバーできる。
- **Phase 6 統合テスト**の前提として、`AIRI_TEST_CLAUDE_CODE=1` 時のみ実 `claude -p "2+2"` を spawn するガードパターンが妥当（POC 実行結果が `result.result: "Hi there friend"` 等で安定取得できることを確認済）。

---

## Phase 1: Electron main — ClaudeCodeService

**目的**: main プロセスで Claude Code セッションを監視/起動する injeca サービスを実装。
**配置**: `apps/stage-tamagotchi/src/main/services/airi/claude-code/`

### ファイル構成
- [x] `index.ts` — `createClaudeCodeManager` (listSessions/attachSession/detachSession/sendPrompt/onEvent/stopAll)
- [x] `session-watcher.ts` — `node:fs.watch` + size-cursor で JSONL tail (chokidar 不要)
- [x] `session-runner.ts` — `node:child_process.spawn` で `claude -p` spawn、stdout 行パース (execa 不要)
- [x] `jsonl-to-stream-event.ts` — 純関数: Claude Code JSONL → `NormalizedClaudeCodeEvent`
- [x] `project-slug.ts` — cwd → `~/.claude/projects/<slug>` 名規則を再現 (`realpath().replace(/[/._]+/g, '-')`)
- [x] `types.ts` — `NormalizedClaudeCodeEvent`, `ClaudeCodeSession`, `ClaudeCodeSessionMeta`

### テスト（TDD: 先に赤テストを書く）
- [x] `jsonl-to-stream-event.test.ts` — サンプル行 → 期待 NormalizedClaudeCodeEvent 配列（14 ケース、user/assistant/system/stream_event/result/meta/unknown を網羅）
- [x] `project-slug.test.ts` — 境界ケース（スラッシュ/アンダースコア/ドット、連続区切り、NUL バイト、実 symlink）10 ケース
- [x] `session-watcher.test.ts` — tmp ディレクトリに write → append、部分書き込み、stop 後無視、parse エラー、ファイル不在 6 ケース
- [x] `session-runner.test.ts` — `vi.mock('node:child_process')` + FakeChild、`--resume` 引数・session_id 取得・非ゼロ終了・stop 6 ケース
- [x] `index.test.ts` — listSessions/attachSession/detachSession/idempotent attach/sendPrompt with runnerFactory の 6 ケース

### 依存追加（Phase 0 の調査結果次第）
- [x] `execa` — **不採用**、`node:child_process.spawn` で代替（配列引数 + `shell: false` で R6 対策済）
- [x] `chokidar` — **不採用**、`node:fs.watch` + size-cursor で代替（POC 検証済、部分書き込み test もパス）

### 品質ゲート
- [x] `pnpm -F @proj-airi/stage-tamagotchi typecheck` pass（node + web 両方）
- [x] `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/claude-code/` 新規テスト全 pass (44/44)
- [x] カバレッジ 84.1% (project-slug 100% / index 89.32% / jsonl-to-stream-event 81.73% / session-runner 81.6% / session-watcher 81.57%)
- [x] `eslint --cache` 0 errors

### 実績ログ

**2026-04-09 — Phase 1 完了**

**実装した公開 API**
```ts
createClaudeCodeManager({
  binaryPath: string,
  claudeProjectsRoot: string,     // ~/.claude/projects を渡す（テストではオーバーライド可）
  runnerFactory?: ...,            // テスト用フック
}): {
  listSessions({ projectDir }): Promise<ClaudeCodeSession[]>
  attachSession({ sessionId, projectDir }): Promise<ClaudeCodeSessionMeta>
  detachSession({ sessionId }): Promise<void>
  sendPrompt({ projectDir, sessionId, text }): Promise<SendPromptResult>
  onEvent(listener): () => void
  stopAll(): Promise<void>
}
```

**技術的な設計判断**
1. **execa / chokidar を採用しない**。`node:child_process.spawn` + `node:fs.watch` + サイズ差分 cursor で十分かつ依存を増やさない。POC で検証済の partial-write ハンドリングを production 実装にも転写。
2. **Manager は Electron / Eventa に依存しない pure domain logic**。Phase 2 で thin Eventa wrapper を被せる。単体試験が vi.mock('electron') 無しで走る。
3. **`runnerFactory` を option で注入**。試験で `createSessionRunner` を差し替えられる。`createClaudeCodeManager` 本体は実 `claude` を触らずに通る。
4. **Buffer events until sessionId is resolved**。新規セッション送信時、`system.init` 行か `SendPromptResult.sessionId` で正しい ID が判明するまで events をバッファし、判明後に一括 flush。これで `onEvent` リスナが常に正確な `sessionId` で呼ばれる。
5. **NUL バイト injection guard** を `projectSlugForRealpath` と `session-runner.sendPrompt` の両方に仕込む (R6 対策)。
6. **Unknown event 退避** (R3): 未知 `type` は `{ kind: 'unknown', raw }` に wrap して落とさない。

**Phase 2 への申し送り**
- `types.ts` の `NormalizedClaudeCodeEvent` / `ClaudeCodeSessionMeta` / `ClaudeCodeSession` を `apps/stage-tamagotchi/src/shared/eventa.ts` から import 可能にする（shared types は `../shared` へ抜き出しても良い、または `claude-code/types.ts` を直接 shared 配下に置く）。
- Eventa contracts は PLAN.md Phase 2 に定義済の通り:
  - `claudeCodeListSessions: defineInvokeEventa<ClaudeCodeSession[], { projectDir: string }>`
  - `claudeCodeAttachSession: defineInvokeEventa<ClaudeCodeSessionMeta, { sessionId, projectDir }>`
  - `claudeCodeDetachSession: defineInvokeEventa<void, { sessionId }>`
  - `claudeCodeSendPrompt: defineInvokeEventa<SendPromptResult, { projectDir, sessionId, text }>`
  - `claudeCodeStreamEvent: defineEventa<{ sessionId: string, event: NormalizedClaudeCodeEvent }>` ← broadcast
- `main/index.ts` への組み込み: `injeca.provide('modules:claude-code-manager', { build: () => createClaudeCodeManager({ binaryPath: <config>, claudeProjectsRoot: join(homedir(), '.claude', 'projects') }) })` を `mcpStdioManager` の後ろあたりに追加。
- 既存 `mcpStdioManager` のように `onAppBeforeQuit(() => manager.stopAll())` でクリーンアップ登録する。

**カバレッジの穴（将来の改善余地）**
- `session-runner.ts` 163-164 行: child spawn error イベント（`child.once('error', ...)`）のテストケース未記述。Phase 6 の統合テストで実バイナリ不在時に自然にカバーされる見込み。
- `session-watcher.ts` 117-119, 126, 132 行: stopped 判定・rerun-after-drain の競合ケース。高負荷 race condition は現状の単体試験ではカバーしていない。

---

## Phase 2: Eventa IPC コントラクト

**目的**: main ↔ renderer の型安全な通信チャネルを定義。

### ファイル
- [x] `apps/stage-tamagotchi/src/shared/claude-code.ts` 新規 — 共有型 (`NormalizedClaudeCodeEvent` / `ClaudeCodeSession` / `ClaudeCodeSessionMeta` / `ClaudeCodeSendPromptResult` / I/O input 型)
- [x] `apps/stage-tamagotchi/src/main/services/airi/claude-code/types.ts` — shared からの re-export に置換（Phase 1 の internal import パスを維持）
- [x] `apps/stage-tamagotchi/src/shared/eventa.ts` に以下を追加:
  - [x] `claudeCodeListSessions: defineInvokeEventa<ClaudeCodeSession[], { projectDir }>`
  - [x] `claudeCodeAttachSession: defineInvokeEventa<ClaudeCodeSessionMeta, { sessionId, projectDir }>`
  - [x] `claudeCodeDetachSession: defineInvokeEventa<void, { sessionId }>`
  - [x] `claudeCodeSendPrompt: defineInvokeEventa<ClaudeCodeSendPromptResult, { projectDir, sessionId, text }>`
  - [x] `claudeCodeStreamEvent: defineEventa<{ sessionId, event: NormalizedClaudeCodeEvent }>` — main→renderer broadcast
- [x] `apps/stage-tamagotchi/src/main/services/airi/claude-code/electron-service.ts` 新規:
  - [x] `setupClaudeCodeManager()` — injeca builder、`onAppBeforeQuit` でクリーンアップ登録、デフォルトで `~/.claude/projects` を使用
  - [x] `createClaudeCodeService({ context, manager })` — 4 invoke handler 登録 + `manager.onEvent` → `context.emit(claudeCodeStreamEvent, ...)` の bridge
- [x] `apps/stage-tamagotchi/src/main/index.ts` — `modules:claude-code-manager` を injeca graph に追加、`chatWindow` が `dependsOn` に追加
- [x] `apps/stage-tamagotchi/src/main/windows/chat/index.ts` — `claudeCodeManager` param を受け取り `setupChatWindowElectronInvokes` に渡す
- [x] `apps/stage-tamagotchi/src/main/windows/chat/rpc/index.electron.ts` — `createClaudeCodeService` を呼び出してハンドラ登録

> **命名調整**: PLAN 初稿の `claudeCodeStartResume` / `claudeCodeStopSession` / `claudeCodeSessionChanged` は、Phase 1 の Manager API と揃えて `claudeCodeAttachSession` / `claudeCodeDetachSession` に統一。`SessionChanged` 専用イベントは現時点で attach 直後の meta 応答で代用可能なため実装しない。

### テスト
- [x] `electron-service.test.ts` — fake `ClaudeCodeManager` を注入して全 handler の routing、send prompt の try/catch、broadcast forwarding、unsubscribe の 7 ケース

### 品質ゲート
- [x] 型が shared 層 (`src/shared/claude-code.ts`) から renderer / main 両方で import 可能
- [x] `pnpm -F @proj-airi/stage-tamagotchi typecheck` pass (node + web)
- [x] `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/claude-code/` 51/51 pass
- [x] `eslint --cache` 0 errors (touched files)

### 実績ログ

**2026-04-09 — Phase 2 完了**

**設計判断**
1. **Shared types を `src/shared/claude-code.ts` に集約**。main の `types.ts` は re-export 専用に変更し、Phase 1 の internal import パスを温存。renderer 側も `src/shared/claude-code.ts` から直接型を取れるので main-only モジュールを引き込まずに済む。
2. **Electron / Eventa wiring は `electron-service.ts` に分離**、`index.ts`（Manager）は pure domain のまま維持。`createClaudeCodeManager` は引き続き Electron 非依存で単体試験できる。
3. **Send prompt の例外は `{ ok: false, error }` に変換**。`errorMessageFrom(@moeru/std)` で extract し、Eventa の reject ではなく構造化結果として renderer に返す。Phase 1 の `SendPromptResult` シェイプと完全互換。
4. **Broadcast 設計**: `manager.onEvent((sid, event) => context.emit(claudeCodeStreamEvent, { sid, event }))` で main→renderer の一方向 push。`createClaudeCodeService` はアンサブスクライブ関数を返し、テストが clean up できるように。
5. **命名を Manager API と一致**: `attachSession` / `detachSession` で統一（PLAN 初稿の `startResume` / `stopSession` を改名、PLAN.md も更新済）。
6. **Injeca の配置**: `mcpStdioManager` の直後。`chatWindow` の `dependsOn` に追加したため、chat ウィンドウ生成時に manager が確実に供給される。
7. **Lifecycle**: `setupClaudeCodeManager` 内で `onAppBeforeQuit(() => manager.stopAll())` を登録。mcp-servers / plugins と同じパターン。

**テスト戦略の変更点**
- 最初は `context.on(claudeCodeStreamEvent, ...)` で broadcast を受信する試験を書いたが、pure `@moeru/eventa` context では subscribe/emit の in-memory loopback が期待通り動かないため、`vi.spyOn(context, 'emit')` で emit 呼び出しを直接検証する方式に変更。Electron adapter 配下でのみ `.on` は実効する前提。

**Phase 3 への申し送り**
- Renderer 側で `claudeCode*` invoke / event を直接扱わず、`packages/stage-ui/src/libs/providers/providers/claude-code/` の Provider 実装に閉じ込める。
- Provider では以下を import する（全て `apps/stage-tamagotchi/src/shared/eventa.ts` から re-export もできるが、stage-ui は apps/tamagotchi に直接依存できないので、provider 側で eventa id 文字列を重複定義するか、`@proj-airi/stage-shared` 経由で共有する必要あり）:
  - `claudeCodeListSessions` / `claudeCodeAttachSession` / `claudeCodeDetachSession` / `claudeCodeSendPrompt` (invoke)
  - `claudeCodeStreamEvent` (subscribe)
- 型は `src/shared/claude-code.ts` を参照したいが、同上の依存方向制約により、Phase 3 の検討事項として「shared types を `packages/stage-shared` に昇格するか、eventa 文字列 + 重複型定義で済ませるか」を判断する必要がある。
- Renderer 側の Eventa 接続は `@proj-airi/electron-vueuse` の `useElectronEventaInvoke` / `getElectronEventaContext` を使う既存パターンを踏襲。
- `binaryPath` の validator は Phase 3 で追加。現時点では `setupClaudeCodeManager` が `'claude'` を素通ししているので、実在しないバイナリで `sendPrompt` を叩くと `child.once('error')` → `{ ok: false }` に落ちるだけで UX としては不親切。

---

## Phase 3: Airi Provider として登録

**目的**: Airi のプロバイダ登録機構に `claude-code` を追加し、チャットから選択できるようにする。
**配置**: `apps/stage-tamagotchi/src/renderer/providers/claude-code/` （**変更**: 当初の `packages/stage-ui/` 案から tamagotchi renderer 配下へ移動）

> **アーキテクチャ判断**: `stage-ui` は `@proj-airi/electron-vueuse` に依存できない（platform-agnostic を維持するため）ので、provider 本体は tamagotchi renderer に置き、`renderer/main.ts` から side-effect import で stage-ui の `providerRegistry` singleton に登録する。`stage-ui` 側には最小分岐 (`isClaudeCodeChatProvider` duck-typing + `streamFrom` 内の早期 return) のみを追加して疎結合を維持。

### ファイル
- [x] `apps/stage-tamagotchi/src/renderer/providers/claude-code/index.ts` — `defineProvider<ClaudeCodeConfig>({ id: 'claude-code', tasks: ['chat'], icon: 'i-simple-icons:anthropic', ... })`
- [x] `apps/stage-tamagotchi/src/renderer/providers/claude-code/config.ts` — Zod schema: `binaryPath` (default `'claude'`) / `projectDir` (required) / `sessionId?`
- [x] `apps/stage-tamagotchi/src/renderer/providers/claude-code/provider.ts` — `createClaudeCodeProvider(config, transport?)` が ChatProvider shim + `__airi_claudeCodeStream` method を返す。`createClaudeCodeStreamDispatcher` が transport を経由して Eventa IPC ブリッジ
- [x] `packages/stage-ui/src/stores/llm.ts` — `isClaudeCodeChatProvider()` duck-typing check + `streamFrom` 冒頭の早期 return で委譲
- [x] `apps/stage-tamagotchi/src/renderer/main.ts` — `import './providers/claude-code'` の side-effect import を追加

### アダプタ実装の要点
- [x] 既存 `@xsai` プロバイダの `chat.completions.create` 風 async iterable インタフェースは**模倣しない** — 代わりに `streamFrom` に分岐点を設け、Claude Code provider 内部は `sendPrompt` + `onStreamEvent` のシンプルな pub/sub パターンで実装
- [x] Eventa `claudeCodeStreamEvent` の subscribe は `ClaudeCodeTransport.onStreamEvent` 経由。`currentSessionId` 判明後はそのセッション ID でフィルタ、未判明時は全 event を forward
- [x] tool_name はそのまま通す（既存 `tool-call-block.vue` が描画）
- [x] `assistant-text` / `tool-call` / `tool-result` / `tool-error` / `finish` / `error` を Airi `StreamEvent` にマッピング、`user-text` / `meta` / `unknown` は drop
- [x] 連続 send 時に `currentSessionId` を closure で保持して `--resume` 相当の継続ができる

### バリデータ
- [x] `validators.validateConfig` で Zod schema 検証（`binaryPath` 空白チェック、`projectDir` required）
- [ ] `binaryPath` の実在確認（`which claude`） — Phase 5 の UI タスクで追加予定
- [ ] 設定画面での赤字警告目視確認 — Phase 5 で実施

### テスト
- [x] `provider.test.ts` — Fake transport で 11 ケース検証: sendPrompt 呼び出し、content-part 配列からの text 抽出、assistant-text → text-delta、tool-call / tool-result / tool-error のマッピング、session ID 継続、エラー伝搬、unsubscribe、cross-session フィルタ、no_input finish、provider shim の marker
- [x] `config.test.ts` — Zod schema の 7 ケース境界テスト（デフォルト、trim、required、空白拒否、optional sessionId）

### 品質ゲート
- [x] `pnpm -F @proj-airi/stage-tamagotchi typecheck` pass (node + web)
- [x] `pnpm -F @proj-airi/stage-ui typecheck` pass
- [x] `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/renderer/providers/claude-code/ src/main/services/airi/claude-code/` → 70/70 pass
- [x] `pnpm -F @proj-airi/stage-ui exec vitest run src/stores/llm` → 24/24 pass（llm.ts 分岐追加による既存 test への影響なし）
- [x] `eslint --cache` touched files → 0 errors
- [ ] チャット画面のプロバイダセレクタに "Claude Code" が表示される — Phase 5 の手動検証で確認

### 実績ログ

**2026-04-09 — Phase 3 完了**

**アーキテクチャ判断の詳細**
当初の PLAN.md 案では provider を `packages/stage-ui/src/libs/providers/providers/claude-code/` に置く設計だったが、以下の理由で `apps/stage-tamagotchi/src/renderer/providers/claude-code/` に移動した:

1. **stage-ui の platform neutrality**: stage-ui は web / electron / capacitor の3 stage で共用される。`@proj-airi/electron-vueuse` を stage-ui deps に追加すると、web build で Electron IPC API が引き込まれ bundle が破綻する。
2. **定義の register は singleton**: `packages/stage-ui/src/libs/providers/providers/registry.ts` の `providerRegistry` は ESM module-level Map。tamagotchi renderer から `defineProvider(...)` を呼べば stage-ui の module instance が共有されるので、設定ページ & チャット orchestrator は variant に関わらず同じ registry を見る。
3. **Electron-specific な副作用は tamagotchi に集約**: 既存の mcp-servers / plugin-host も tamagotchi 側に実装されており、パターンとして一致。

**stage-ui 側の分岐点**
```ts
// packages/stage-ui/src/stores/llm.ts
const AIRI_CLAUDE_CODE_STREAM_METHOD = '__airi_claudeCodeStream' as const

export function isClaudeCodeChatProvider(chatProvider): chatProvider is ChatProvider & ClaudeCodeChatProviderMarker {
  return typeof chatProvider[AIRI_CLAUDE_CODE_STREAM_METHOD] === 'function'
}

async function streamFrom(...) {
  if (isClaudeCodeChatProvider(chatProvider)) {
    await chatProvider[AIRI_CLAUDE_CODE_STREAM_METHOD](messages, options)
    return
  }
  // ... existing xsai path unchanged
}
```
3 行の早期 return + 型ガード関数 1 個のみ。他の既存 provider のパスは完全に不変。

**Scope 簡略化**
- **mirror 機能は Phase 5 に後回し**: `attachSession` を用いて TUI セッションを backfill mirror するのは Phase 3 では行わず、`sendPrompt` 単体で "Airi から送信 → 応答をストリーム" のフローのみ実装。理由: session runner の stdout と session watcher の JSONL tail を同時に動かすと同じイベントが二重配信されるため dedup が必要で、それは Phase 5 の session selector UI と一緒に設計する方が整合する。
- **session id の継続は closure state で実装**: `createClaudeCodeStreamDispatcher` が `currentSessionId` を mutable 変数として保持し、初回 sendPrompt 結果で確定、以降の call で `--resume` 相当の継続を行う。config の `sessionId` が初期値として使える。

**テスト戦略**
- `provider.test.ts` では `getElectronEventaContext` を一切呼ばず、`ClaudeCodeTransport` interface を注入する形で fake transport を使う（production 用の `createDefaultTransport()` は test から呼ばない）。これにより Electron 環境なしで 11 ケースが走る。
- `stream-event のタイミング制御` が必要なテスト（assistant-text の forward、cross-session filter 等）では `sendPrompt` の Promise を手動で resolve するパターンで、event emit → resolve の順序を保証。

**既存テストの退行確認**
- stage-tamagotchi の full vitest run で確認したところ、事前存在の 4 件 failure (`plugins/index.test.ts` × 4 + `display.test.ts`) が再現。Phase 3 変更を stash した状態でも同じ failure が発生するため、これらは Phase 3 とは無関係の pre-existing 問題（`--ignore-scripts` による isolated-vm native 未ビルド等が原因と推定）。

**Phase 4 (i18n) / Phase 5 (UI) への申し送り**
- provider の `name` / `description` / `nameLocalize` / `descriptionLocalize` は現在ハードコード英文。Phase 4 で `packages/i18n/src/locales/*/settings.yaml` に `settings.pages.providers.provider.claude-code.*` キーを追加し、localised 関数を差し替える。
- `binaryPath` の実在確認 (which claude 相当) は Phase 5 で追加。現状 Zod schema は文字列 trim / min(1) のみ。main 側に `claudeCodeCheckBinary` invoke を新設し、validateConfig から呼ぶと良い。
- session selector UI (Phase 5) では `claudeCodeListSessions` invoke → drop-down → 選択後 `claudeCodeAttachSession` → backfill event を historical として ingest → 以降の live event を dedup (UUID ベース) という流れが必要。現状の provider は attach を呼ばないので、UI から呼ばれたら別経路で ingest する形を取る。
- `assistant-thinking` block は現在 text-delta として forward しているが、Phase 5 で `tool-call-block.vue` のような専用 UI スライスを作って visual に区別するのが望ましい。

---

## Phase 4: i18n

**目的**: 設定画面の文言を多言語化。
**配置**: `packages/i18n/src/locales/*/settings.yaml`

### 対象ロケール
- [x] `en` (mandatory) — `pages.providers.provider.claude-code` ブロック追加
- [x] `ja` (mandatory) — 日本語訳追加
- [x] `zh-Hans` (mandatory) — 简体中文訳追加
- [x] 他ロケール（es / fr / ko / ru / vi / zh-Hant）は未着手 — vue-i18n fallback で en を表示する

### 実装されたキー構造
`settings.pages.providers.provider.claude-code.*` の下に以下:
- `title` — プロバイダー名
- `description` — プロバイダー説明
- `fields.field.binary-path.{label,description,placeholder}`
- `fields.field.project-dir.{label,description,placeholder}`
- `fields.field.session-id.{label,description,placeholder}` — advanced section

### タスク
- [x] en キー追加
- [x] ja キー追加
- [x] zh-Hans キー追加
- [x] 他ロケールは en fallback 確認（vue-i18n の既定 fallback 挙動で英文が表示される）
- [x] `apps/stage-tamagotchi/src/renderer/providers/claude-code/index.ts` を `nameLocalize` / `descriptionLocalize` / `createProviderConfig` で `t(...)` を使うよう更新
- [x] `binary-path` / `project-dir` / `session-id` それぞれに `.meta({ labelLocalized, descriptionLocalized, placeholderLocalized })` を設定、`session-id` は `section: 'advanced'` でフォームの下部に配置

### 品質ゲート
- [x] yaml パース: 3 ロケール全てで `pages.providers.provider.claude-code` ツリーが正しく読め、全キー値が取得できること確認
- [x] `pnpm -F @proj-airi/stage-tamagotchi typecheck` pass
- [x] `pnpm -F @proj-airi/i18n typecheck` pass
- [x] `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/renderer/providers/claude-code/ src/main/services/airi/claude-code/` → 70/70 pass (既存テストに退行なし)
- [x] `eslint --cache` touched files → 0 errors

### 実績ログ

**2026-04-09 — Phase 4 完了**

**設計判断**
1. **キー階層は `pages.providers.provider.claude-code`** — 既存の `anthropic` / `cloudflare-workers-ai` / `ollama` と同じ alphabetical に並ぶ位置に挿入（anthropic < claude-code < cloudflare）。
2. **Field localization は `.meta({ labelLocalized, ... })` 方式** — 既存 ollama の thinking-mode フィールドと同じパターンを踏襲。フォームオートジェネレータ（Zod schema → UI）が自動で i18n を拾う。
3. **`session-id` は advanced section** — ほとんどのユーザーは設定せず自動で新セッションが作られるため、`meta({ section: 'advanced' })` でフォーム下部に隠す。
4. **fallback strings は英語のまま残す** — `name` / `description` の hardcode 英文は `t()` が見つからない場合の fallback として vue-i18n が使用する（定義 system の `ProviderDefinition` が必須プロパティとして要求）。
5. **es / fr / ko / ru / vi / zh-Hant は未翻訳** — Phase 4 MVP は main 3 locale のみに絞り、他は vue-i18n の自動 fallback で英文表示にする。将来 `chore(i18n): update translations` のコミット（例: PR #1603）と同じ流れで OSS コントリビュータから追加される想定。

**Phase 5 への申し送り**
- 設定ページで `claude-code` provider を選択した際、3 つのフィールドが正しくラベル表示されることを手動検証する。
- `binaryPath` 実在確認バリデータを追加する際は、エラーメッセージも i18n キー化する（例: `pages.providers.provider.claude-code.errors.binary-not-found`）。
- `assistant-thinking` ブロック用の UI スライスを追加する際は、ラベルも i18n 化する（例: `components.chat.thinking.label`）。

---

## Phase 5: UI — 設定ページ & セッションセレクタ

**目的**: プロバイダ設定画面と、チャット画面でのセッション切り替え UI を整える。

### 5.1 設定ページ
- [x] Zod schema の自動フォーム化で動作することを確認 — `createProviderConfig` で `binaryPath` / `projectDir` / `sessionId` それぞれ `.meta({ labelLocalized, descriptionLocalized, placeholderLocalized })` 済（Phase 4 で実装）
- [x] `binaryPath` 未設定時の警告表示 — 実際には `projectDir` / `binaryPath` の**実在確認**を非同期バリデータで実装: `claudeCodeCheckBinary` invoke で `<binaryPath> --version` を実行し失敗時に赤字警告
- [x] `projectDir` 実在確認 — `claudeCodeResolveSlug` invoke が `fs.realpath` → slug に変換し、ENOENT 等を structured error として surface
- [ ] `projectDir` に対応する slug のプレビュー表示 — バックエンドの `claudeCodeResolveSlug` invoke は実装済だが、設定画面の表示スロットに slug を出すコンポーネント改修は手動検証を伴うため未実装（将来作業に委ねる）

### 5.2 セッションセレクタ（optional, 余裕があれば）
- [ ] `packages/stage-ui/src/components/scenarios/chat/claude-code-session-switcher.vue` 新規 — **未実装**。ビジュアル検証なしに UI を landingするのはリスクが高いため、手動検証が可能なセッションでの実装に委ねる
- [ ] チャットヘッダに現在セッション ID を表示 — 同上
- [ ] 「最新の TUI セッションに接続」ボタン — 同上（`claudeCodeListSessions` invoke は Phase 2 で既に使える状態）
- [ ] セッション一覧ドロップダウン — 同上

### 実装したファイル
- [x] `apps/stage-tamagotchi/src/main/services/airi/claude-code/binary-prober.ts` 新規 — `createDefaultBinaryProber()` が `spawn('<binaryPath>', ['--version'])` を安全に実行、5 秒タイムアウト / NUL byte guard / stderr error surfacing を含む
- [x] `apps/stage-tamagotchi/src/main/services/airi/claude-code/index.ts` — Manager に `checkBinary` / `resolveSlug` メソッド追加、`binaryProber` option injection で差し替え可能
- [x] `apps/stage-tamagotchi/src/shared/claude-code.ts` — `ClaudeCodeCheckBinaryResult` / `ClaudeCodeCheckBinaryInput` / `ClaudeCodeResolveSlugResult` / `ClaudeCodeResolveSlugInput` 型追加
- [x] `apps/stage-tamagotchi/src/shared/eventa.ts` — `claudeCodeCheckBinary` / `claudeCodeResolveSlug` 2 invoke contracts 追加
- [x] `apps/stage-tamagotchi/src/main/services/airi/claude-code/electron-service.ts` — 2 新 invoke handler を `defineInvokeHandlers` に追加、`errorMessageFrom` で例外を structured result に変換
- [x] `apps/stage-tamagotchi/src/renderer/providers/claude-code/provider.ts` — `ClaudeCodeTransport` interface に `checkBinary` / `resolveSlug` を追加、`createDefaultTransport()` が両 invoke を wrap
- [x] `apps/stage-tamagotchi/src/renderer/providers/claude-code/validate.ts` 新規 — `validateClaudeCodeConfig(config, transport, t?)` 関数。projectDir の required 判定 → `resolveSlug` → `checkBinary` の順で実行、エラーは `errorKey` 付きで i18n キーを添付、transport 例外も捕捉して structured error に変換
- [x] `apps/stage-tamagotchi/src/renderer/providers/claude-code/index.ts` — `validateConfig` hook で Zod schema 検証 → 新しい `validateClaudeCodeConfig` を呼ぶ流れに差し替え、validator 名も i18n 化
- [x] `packages/i18n/src/locales/{en,ja,zh-Hans}/settings.yaml` — `validators.check-config.title` と 5 `errors.*` キーを追加（3 ロケール）

### テスト追加分
- [x] `binary-prober.test.ts` — 6 ケース: spawn 引数 / 成功 (stdout) / 非ゼロ終了 / spawn error (ENOENT) / NUL byte guard / 5 秒タイムアウト / 空 stdout fallback
- [x] `index.test.ts` — checkBinary delegation (成功/失敗) + resolveSlug (existing dir / missing dir) 4 ケース
- [x] `electron-service.test.ts` — claudeCodeCheckBinary routing / checkBinary 例外変換 / claudeCodeResolveSlug routing 3 ケース
- [x] `validate.test.ts` — 8 ケース: full success / projectDir required / resolveSlug error / checkBinary error / 空白 binaryPath で 'claude' default / transport 例外 → structured / t() localisation / fallback

### 品質ゲート
- [x] `pnpm -F @proj-airi/stage-tamagotchi typecheck` pass (node + web)
- [x] `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/renderer/providers/claude-code/ src/main/services/airi/claude-code/` → **91/91 pass**（Phase 4 時点 70 → +21）
- [x] `eslint --cache` touched files → 0 errors
- [x] i18n YAML key coverage チェック (3 locale × 8 必須キー = 24 キー) 全て存在
- [ ] **設定画面で値を変更 → 永続化 → 再起動後も保持される** — 手動検証必須、ユーザーに委ねる
- [ ] **プロバイダ切り替えでチャット履歴がリセットされない** — 手動検証必須

### 実績ログ

**2026-04-09 — Phase 5 部分完了**

**自動化した範囲**
Phase 5 のタスクのうち、ビジュアル検証を伴わないバックエンド + validation ロジックを完全に実装。チャット UI の手動検証タスクとセッションセレクタ Vue コンポーネント（`claude-code-session-switcher.vue`）は UI 実機検証なしに出荷するとユーザー体験を壊すリスクが高いため、残保留にしている。

**設計判断**
1. **`binary-prober.ts` を別ファイルに切り出す**: `spawn('--version')` ロジックを `index.ts` から分離し、`BinaryProber` 関数型で DI 可能に。Manager option `binaryProber` で fake を差し込める → テストが実バイナリを触らず走る。
2. **5 秒タイムアウト**: hung binary で settings 画面がハングするリスクを避けるため。`claude --version` は通常 < 500ms。
3. **`validate.ts` を provider から分離**: validator ロジックを `index.ts`（定義登録）から独立させ、`createDefaultTransport()` を lazy に呼ぶ形にすることで、テスト時は fake transport を直接差し込める。
4. **Error keys の i18n**: 各 validation error に `errorKey` フィールド（例: `settings.pages.providers.provider.claude-code.errors.binary-not-found`）を添付、設定画面の error renderer はこの key を使って localised message を表示する（既存 Airi の error surface の慣習に従う）。
5. **Transport 例外も structured**: `resolveSlug` / `checkBinary` invoke が IPC で throw した場合、validator は rejection ではなく `{ error: ..., errorKey: '*-transport' }` に変換する → チェックが常に完走しフォームが固まらない。
6. **`validateConfig` 内で Zod parse → async probe の 2 段階**: 静的 field 不足エラー（e.g., projectDir missing）を先に出して IPC を節約。Zod が通ったら async probe で実在確認。
7. **`t()` のフォールバック**: test では `t()` を undefined で呼ぶ or key-passthrough スタブで動作するよう、`translate()` ヘルパーを書いた。`t(key) === key` のケース（未 localised）でも英文 default を返す。

**スコープ外（ユーザー手動検証に委ねた範囲）**
1. **設定画面のビジュアル検証**: `pnpm -F @proj-airi/stage-tamagotchi dev` で Electron を起動し、Settings → Providers → Claude Code を選択、バリデータが正しく赤字警告を出す/隠れる/validator 名が localised されていることを目視確認する必要あり。
2. **永続化 & プロバイダ切り替え**: Airi の既存 provider 設定永続化機構（pinia-plugin-persistedstate 等）に載っているので理論上は動くが、実行環境確認が必要。
3. **セッションセレクタ UI**: `claude-code-session-switcher.vue` を作る場合、`useElectronEventaInvoke(claudeCodeListSessions)` → ドロップダウン → 選択時 `claudeCodeAttachSession` → backfill の流れ。ただし Phase 3 で触れた通り、attach 中は watcher + runner double-delivery の dedup 設計が必要で、本実装は Phase 6 / Phase 7 の後に UI polish として残した方が良い。
4. **slug preview**: `claudeCodeResolveSlug` 自体は実装済。設定画面の field description slot に slug を live 表示するコンポーネント改修は、Airi の `createProviderConfig` がサポートする `meta` キーが現時点で "static string のみ" のため、reactive な slot が必要 → 要デザイン / 実装。

**Phase 6 (テスト & 品質) / Phase 7 (ドキュメント) への申し送り**
- `binary-prober.ts` の `BinaryProber` は外部から差し替え可能な DI point として確立済み。Phase 6 の integration test で `AIRI_TEST_CLAUDE_CODE=1` gate の下で real `claude --version` を走らせるなら、この DI を通さず default prober を使えば良い。
- validator error key は全て `settings.pages.providers.provider.claude-code.errors.*` に揃えているので、他 locale への翻訳 PR は単一 YAML ブロックの追加で済む。
- セッションセレクタ UI を後で追加する場合、必要な IPC contracts は既に全て揃っている (`claudeCodeListSessions` / `claudeCodeAttachSession` / `claudeCodeDetachSession` / `claudeCodeStreamEvent`)。

---

## Phase 6: テスト & 品質

**目的**: 80%+ カバレッジ + 統合テスト + 手動検証シナリオ文書化。

### 自動テスト
- [x] Phase 1 ユニットテスト群 pass（64 cases、binary-prober 追加分含む）
- [x] Phase 3 provider テスト pass（18 cases → 24 cases、coverage 上乗せ分含む）
- [x] Phase 5 validator テスト pass（8 cases）
- [x] **統合テスト** `apps/stage-tamagotchi/src/main/services/airi/claude-code/integration.test.ts` 新規
  - [x] `process.env.AIRI_TEST_CLAUDE_CODE === '1'` でのみ実行（`describe.skip` gate）
  - [x] 実 `claude -p "Reply with just the number: 2+2"` を spawn し、`assistant-text` + `finish` + 同一 sessionId 収束を確認
  - [x] `checkBinary` が実 `claude --version` に対して `{ ok: true, version: /\d+\.\d+\.\d+/ }` を返すことを確認
  - [x] `resolveSlug` が tmp project dir を正しく canonical slug に変換することを確認
  - [x] 環境変数無しで 3 tests skipped、有りで 3/3 pass (約 6 秒) を実機確認
- [x] カバレッジレポートで **86.66%** を達成（target 80%+ クリア）
  - `binary-prober.ts`: 94.59%
  - `project-slug.ts`: 100%
  - `validate.ts`: 96.15%
  - `index.ts` (manager): 90.35%
  - `provider.ts` (renderer): 80.82%
  - `electron-service.ts`: 82.05%
  - `jsonl-to-stream-event.ts`: 81.73%
  - `session-runner.ts`: 81.6%
  - `session-watcher.ts`: 81.57%
  - `config.ts`: 100%
  - `shared/eventa.ts`: 100%

### 手動検証シナリオ
**文書化**: `docs/integrations/claude-code-manual-verification.md` 新規作成。全 5 シナリオ + セキュリティレビュー + 永続化 & UX チェックリスト + リリースゲーティングを定義。

- [ ] **シナリオ A** (ターミナル TUI → Airi mirror) — ⚠️ Phase 5 follow-up の session-switcher UI が必要なため deferred
- [ ] **シナリオ B** (Airi 送信 → round-trip) — 手動検証必須
- [ ] **シナリオ C** (tool-call rendering) — 手動検証必須
- [ ] **シナリオ D** (不正 binaryPath → バリデータ警告) — 手動検証必須、チェックリスト上で i18n キー名まで明記
- [ ] **シナリオ E** (claude プロセス kill → error propagation) — 手動検証必須

> 手動実行のチェック項目は `docs/integrations/claude-code-manual-verification.md` のチェックボックスで追跡する。リリース PR には上記ファイル内のボックスを埋めた状態でリンクする。

### 品質ゲート（コミット前必須）
- [x] `pnpm -F @proj-airi/stage-tamagotchi typecheck` pass (node + web)
- [x] `pnpm -F @proj-airi/stage-ui typecheck` pass
- [x] `pnpm -F @proj-airi/i18n typecheck` pass
- [x] `eslint --cache` touched files → 0 errors（自動修正後）
- [x] `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/renderer/providers/claude-code/ src/main/services/airi/claude-code/` → **99 passed + 3 skipped** (Phase 5 時点 91 → +8 cases)
- [x] security review（Phase 6 実績ログ参照）

### 実績ログ

**2026-04-09 — Phase 6 自動部分完了**

**統合テストの構成**
`integration.test.ts` は `describe.skip` gate (`AIRI_TEST_CLAUDE_CODE` 環境変数) で opt-in する設計。3 ケース:
1. **sendPrompt "2+2"**: tmp projectDir + tmp claudeProjectsRoot を使い、実 `claude -p "Reply with just the number: 2+2"` を spawn。`assistant-text` と `finish` event が届くこと、全 event の sessionId が 1 つに収束すること、`result.sessionId` が truthy であることを assertion。タイムアウト 120 秒（API レスポンス + rate limit 吸収）。
2. **checkBinary against real CLI**: `/usr/local/bin/claude` を probe し `version` が `/\d+\.\d+\.\d+/` パターンで返ることを確認。タイムアウト 15 秒。
3. **resolveSlug for tmp project dir**: tmp ディレクトリが `-...` 形式の slug に正しく flatten されることを確認。

実行結果（Phase 6 自動部分完了時点）:
- `AIRI_TEST_CLAUDE_CODE` 未設定 → 3 tests skipped ✓
- `AIRI_TEST_CLAUDE_CODE=1` → 3 tests passed in 6.18s ✓（実 Claude Code CLI に対する live 検証）

**カバレッジ向上の追加テスト**
Phase 5 時点のカバレッジは 84.65% で目標達成していたが、Phase 6 ではさらに以下の穴を埋めた:

- `provider.test.ts`: 73.97% → 80.82%
  - `assistant-thinking` → text-delta マッピング
  - 中間 `finish` event の forward
  - 中間 `error` event の forward
  - `user-text` / `meta` / `unknown` event の drop 確認
  - 非 string tool-result の JSON.stringify パス
- `electron-service.test.ts`: 61.53% → 82.05%
  - `setupClaudeCodeManager` factory 経由の `onAppBeforeQuit` 登録確認
  - shutdown callback 内の `manager.stopAll()` 呼び出し確認
  - shutdown callback 内の `manager.stopAll()` 例外 swallowing 確認
  - `resolveSlug` 例外 → `{ ok: false, error }` 変換確認

**セキュリティレビュー (Phase 6 手動チェック)**
1. **Command injection**: `session-runner.ts`, `binary-prober.ts`, `session-runner.test.ts` を目視 review。両方とも `spawn(binaryPath, args, { shell: false })` の配列形式、string interpolation 無し。NUL byte guard は両方で明示的に実装済み。
2. **Path escape**: `project-slug.ts` の `projectSlugForRealpath` が `fs.realpath` 済みの path しか受け取らないこと、NUL byte を explicit reject することを確認。`resolveSlug` ハンドラは `fs.realpath` を経由してから slug 化しており escape リスク無し。
3. **Timeout**: `binary-prober.ts` の 5 秒 timeout は `setTimeout` + `child.kill('SIGTERM')` で実装、fake timer test で検証済み。`session-runner.ts` の spawn には明示的 timeout は無いが、Airi 側の `stopAll()` 経由で abort 可能。
4. **JSONL line size**: `session-watcher.ts` の cursor-based reader は line size に上限を設けていない。Phase 0 で 130kB+ の line を観測済みだが問題なく処理できることを確認。
5. **Secret leakage in logs**: `electron-service.ts` の `useLogg` 呼び出しは broadcast error のみ `log.withError(error).warn(...)` で記録。event raw payload (user prompts / tool outputs) は logger に渡していないため credential leak のリスク低。Phase 7 の docs で明文化予定。

**Phase 7 (ドキュメント) への申し送り**
- 手動検証チェックリスト `docs/integrations/claude-code-manual-verification.md` は既に作成済。Phase 7 はこれに加えて:
  - `apps/stage-tamagotchi/src/main/services/airi/claude-code/README.md` — 主要モジュール配置図、debugging tips
  - `apps/stage-tamagotchi/src/renderer/providers/claude-code/README.md` — Provider pattern description + stream-ui branch 説明
  - `docs/integrations/claude-code.md` — end-to-end setup (Claude Code インストール → Airi 設定 → 接続確認) + アーキテクチャ図 + トラブルシューティング
- `docs/integrations/claude-code-jsonl-schema.md` (Phase 0 作成済) / `claude-code-manual-verification.md` (Phase 6 作成済) との cross-reference を追加
- カバレッジ番号 86.66% を README に記載、CI で継続監視できるよう workspace vitest.config.ts にカバレッジ threshold を追加するかどうかは Phase 7 の判断事項

---

## Phase 7: ドキュメント

**目的**: 運用/保守担当者（未来の自分含む）がゼロから理解できる README を残す。

### ファイル
- [ ] `apps/stage-tamagotchi/src/main/services/airi/claude-code/README.md`
  - 何を / どう使う / いつ使う / いつ使わない
  - JSONL スキーマへのリンク
  - デバッグ方法
- [ ] `packages/stage-ui/src/libs/providers/providers/claude-code/README.md`
  - Provider 登録パターン説明
  - Eventa 契約との繋がり
- [ ] `docs/integrations/claude-code.md`
  - セットアップ手順（Claude Code インストール → Airi 設定 → 接続確認）
  - アーキテクチャ図
  - トラブルシューティング
- [ ] `docs/integrations/claude-code-jsonl-schema.md` (Phase 0 で作成済みのはず)

### 実績ログ
<!-- -->

---

## リスク & 対策

| # | リスク | 影響度 | 対策 | 状態 |
|---|---|---|---|---|
| R1 | JSONL flush 順が保証されない | 中 | 行ごとに `uuid` dedupe、`chokidar` の低レイテンシ設定 | ⬜ |
| R2 | `--resume` のセッション ID 取得タイミング | 中 | headless stdout 1行目 `{type:"system",subtype:"init"}` に `session_id` あり（Phase 0 で確認） | ✅ 解決 |
| R3 | Claude Code バージョン差で JSONL スキーマ変化 | 高 | `types.ts` に集約、未知 `type` は `{type:'unknown', raw}` で退避。POC では 2.1.96 を固定 | 🟨 緩和中 |
| R4 | バイナリ未インストール時の UX | 低 | プロバイダ validator で `which claude`、赤字警告 | ⬜ |
| R5 | TUI / Airi 同時編集 race | 低 | `--resume` は追記型、PreToolUse hook で二重送信検知は保険 | ⬜ |
| R6 | コマンドインジェクション（`projectDir` など） | 高 | `execa` の配列形式のみ使用、shell: false を強制 | ⬜ |
| R7 | macOS/Linux/Windows パス差異 | 中 | `path` モジュール + POSIX 正規化、OS 別テスト | ⬜ |

---

## スコープ外（やらないこと）

- ❌ Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) の直叩き統合
- ❌ Airi → Claude Code 方向の MCP サーバ化
- ❌ `stage-web` / `stage-pocket` への展開
- ❌ セッション分岐/フォーク UI の新設（既存 `ingestOnFork` 再利用のみ）
- ❌ バックワード互換性配慮（AIRI の方針）

---

## 作業ログ（時系列）

> 形式: `YYYY-MM-DD HH:MM | Phase X.Y | 作業内容 | 成果物 / 気づき`

| 日時 | Phase | 作業 | メモ |
|---|---|---|---|
| 2026-04-08 | — | 実装計画を策定・PLAN.md 作成 | 3並列エージェントで調査完了、ハイブリッド経路採用 |
| 2026-04-08 | 0 | JSONL スキーマ調査 (Explore agent + 直検証) | transcript / stream 両 dialect の event 型を網羅、`system.init` から `session_id` が即時取得できることを確認 |
| 2026-04-08 | 0 | slug 変換ルール確認 | `/` / `_` / `.` → `-` の歪曲写像。realpath 解決必須。`/private/tmp/a.b_c/d.e` で実測 |
| 2026-04-08 | 0 | `--resume` 検証 | 既存 `<id>.jsonl` に追記されること（47240→49096 bytes）、session_id が維持されることを確認 |
| 2026-04-08 | 0 | `docs/integrations/claude-code-jsonl-schema.md` 作成 | transcript/stream 両 dialect + StreamEvent マッピング + セキュリティ注意点 |
| 2026-04-08 | 0 | `scripts/poc/claude-code-tail.mjs` 作成 & 動作確認 | 実セッションファイルを tail して全 event 型を整形出力。依存ゼロ |
| 2026-04-08 | 0 | Phase 0 完了 ✅ | R2 解決、execa/chokidar 未導入を Phase 1 で対応 |
| 2026-04-09 | 1 | TDD で `project-slug` / `jsonl-to-stream-event` / `session-watcher` / `session-runner` / `index` 実装 | 44 tests pass / coverage 84% / typecheck pass / eslint 0 errors |
| 2026-04-09 | 1 | execa/chokidar は採用せず `node:child_process.spawn` + `node:fs.watch` で代替 | 依存追加ゼロ。POC の cursor パターンを production 実装に転写 |
| 2026-04-09 | 1 | Phase 1 完了 ✅ | Manager API 完成、Phase 2 (Eventa IPC) に申し送り |
| 2026-04-09 | 2 | shared types を `src/shared/claude-code.ts` へ抽出、main の `types.ts` を re-export に | renderer 側も main-only 依存なしで型を import 可能 |
| 2026-04-09 | 2 | 5 Eventa contracts を `src/shared/eventa.ts` に追加 | list/attach/detach/sendPrompt/streamEvent |
| 2026-04-09 | 2 | `electron-service.ts` 作成 (`setupClaudeCodeManager` + `createClaudeCodeService`) | pure manager と Electron wiring を分離 |
| 2026-04-09 | 2 | `main/index.ts` injeca graph + `chat/rpc/index.electron.ts` に wire | `modules:claude-code-manager` → `chatWindow` `dependsOn` |
| 2026-04-09 | 2 | `electron-service.test.ts` 7 ケース (fake manager + spyOn emit) | 51/51 green / typecheck pass / eslint clean |
| 2026-04-09 | 2 | Phase 2 完了 ✅ | main ↔ renderer 型安全 IPC 完成、Phase 3 (Provider 登録) に申し送り |
| 2026-04-09 | 3 | stage-ui `llm.ts` に `isClaudeCodeChatProvider` 分岐追加 | duck-typed marker `__airi_claudeCodeStream`、既存 xsai path 完全に不変 |
| 2026-04-09 | 3 | tamagotchi renderer 配下に provider 実装 (`providers/claude-code/`) | config / provider / index の 3 ファイル + fake transport テスト 11 ケース |
| 2026-04-09 | 3 | `renderer/main.ts` 側 side-effect import で registry 登録 | stage-ui の providerRegistry singleton に自動登録 |
| 2026-04-09 | 3 | Phase 3 完了 ✅ | 70/70 tests pass, typecheck/lint clean, mirror は Phase 5 に後回し |
| 2026-04-09 | 4 | en / ja / zh-Hans に `pages.providers.provider.claude-code` ブロック追加 | title / description + 3 フィールドの label / description / placeholder |
| 2026-04-09 | 4 | provider `index.ts` を `nameLocalize` / `createProviderConfig` で `t(...)` 化 | session-id を advanced section に配置 |
| 2026-04-09 | 4 | Phase 4 完了 ✅ | 他 locale は vue-i18n fallback で英文表示、将来の翻訳 PR に委ねる |
| 2026-04-09 | 5 | Main 側に `checkBinary` + `resolveSlug` invoke 追加 | `binary-prober.ts` 新設 (spawn `<bin> --version`, 5s timeout, NUL guard) |
| 2026-04-09 | 5 | Provider validator に `validate.ts` 新設、 IPC で非同期プローブを実行 | errorKey 付きで i18n 化、transport 例外は structured error に変換 |
| 2026-04-09 | 5 | 3 ロケールに `validators` / `errors` i18n キー追加 | en / ja / zh-Hans (8 キー × 3 = 24) |
| 2026-04-09 | 5 | Phase 5 部分完了 🟨 | 91/91 tests pass / 自動部分完了 / ビジュアル検証 & session-switcher UI は保留 |
| 2026-04-09 | 6 | `integration.test.ts` 新設 (`AIRI_TEST_CLAUDE_CODE=1` gate) | sendPrompt "2+2" / checkBinary / resolveSlug の 3 ケース、実 CLI で 6.18s pass |
| 2026-04-09 | 6 | provider.ts / electron-service.ts のカバレッジ穴を埋めるテスト追加 | provider 73.97→80.82%、electron-service 61.53→82.05% |
| 2026-04-09 | 6 | 全ゲート確認 | 99/99 pass (+3 skipped integration)、coverage 86.66%、typecheck/lint clean |
| 2026-04-09 | 6 | `docs/integrations/claude-code-manual-verification.md` 作成 | 5 シナリオ + セキュリティ review + 永続化 & UX + リリースゲーティング |
| 2026-04-09 | 6 | Phase 6 自動部分完了 🟨 | 自動テスト & カバレッジ & セキュリティ目視完了。手動シナリオ A-E はリリース前に実機確認 |

---

## 参考

### 調査済みファイル（Airi 側）
- `packages/stage-ui/src/components/scenarios/chat/history.vue`
- `packages/stage-ui/src/components/scenarios/chat/tool-call-block.vue`
- `packages/stage-ui/src/types/chat.ts` — `ChatHistoryItem`, `ChatSlices`
- `packages/stage-ui/src/stores/chat.ts` — `useChatOrchestratorStore`
- `packages/stage-ui/src/stores/chat/stream-store.ts` — `appendStreamLiteral`, `finalizeStream`
- `packages/stage-ui/src/stores/llm.ts:18-24` — `StreamEvent` 型
- `packages/stage-ui/src/libs/providers/types.ts:119-203` — `ProviderDefinition`
- `packages/stage-ui/src/libs/providers/providers/ollama/index.ts` — プロバイダ実装リファレンス
- `apps/stage-tamagotchi/src/shared/eventa.ts` — IPC 契約
- `apps/stage-tamagotchi/src/main/services/airi/mcp-servers/index.ts` — 子プロセス spawn パターン
- `apps/stage-tamagotchi/src/main/windows/chat/rpc/index.electron.ts` — ハンドラ登録例

### Claude Code ドキュメント
- https://code.claude.com/docs/en/overview.md
- https://code.claude.com/docs/en/headless.md — `-p` / `--output-format stream-json` / `--resume`
- https://code.claude.com/docs/en/hooks-guide.md — SessionStart / UserPromptSubmit / PreToolUse / PostToolUse
- https://platform.claude.com/docs/en/agent-sdk/overview.md — （参照のみ、採用しない）
- https://code.claude.com/docs/en/channels-reference.md — （将来拡張の候補）

### コマンドリファレンス（Airi）
```bash
# 型チェック
pnpm -F @proj-airi/stage-tamagotchi typecheck
pnpm -F @proj-airi/stage-ui typecheck

# テスト
pnpm -F @proj-airi/stage-tamagotchi exec vitest run
pnpm -F @proj-airi/stage-ui exec vitest run
pnpm test:run  # 全体

# Lint
pnpm lint:fix

# ビルド
pnpm -F @proj-airi/stage-tamagotchi build
```

---

## 方針転換: 読み上げモード (2026-04-11)

### 背景

チャットウインドウ統合（Phase 3-8）で以下の問題に直面:
- マルチウインドウ authority/follower 構造による IPC 複雑化
- Eventa adapter の envelope unwrapping / listener leak
- `--include-partial-messages` による duplicate text delta（異なる UUID で同一テキスト出力）
- chat-sync の 30 秒 timeout

根本的に「Airi からプロンプト送信」するアプローチを撤回し、**パッシブ監視 + 読み上げ** に切り替える。
参考: [cc-mascot](https://github.com/kazakago/cc-mascot) ([解説記事](https://qiita.com/kazakago/items/287f91082ab59f581c09))

### アーキテクチャ

```
Claude Code CLI → ~/.claude/projects/<slug>/<session>.jsonl
                     ↓ SessionWatcher (既存 Phase 1)
              normalizeClaudeCodeLine → assistant-text 抽出
                     ↓ Eventa claudeCodeStreamEvent (既存 Phase 2)
              ClaudeCodeSpeechBridge (★ 新規 composable)
                     ↓ textFilter でMarkdown/コード除去 (★ 新規)
              characterStore.emitTextOutput(cleanedText) (既存 API)
                     ↓
              speechRuntime → TTS API → AudioBuffer → wLipSync
                     ↓
              VRM expressionManager → キャラが口パクで読み上げ ✅
```

### 継続使用するコード

| ファイル | Phase | 用途 |
|---|---|---|
| `main/services/airi/claude-code/session-watcher.ts` | 1 | JSONL tail |
| `main/services/airi/claude-code/jsonl-to-stream-event.ts` | 1 | イベント正規化 |
| `main/services/airi/claude-code/project-slug.ts` | 1 | slug 解決 |
| `main/services/airi/claude-code/index.ts` | 1 | Manager (listSessions/attachSession) |
| `main/services/airi/claude-code/binary-prober.ts` | 5 | バイナリ実在確認 |
| `main/services/airi/claude-code/electron-service.ts` | 2 | Eventa handler |
| `shared/claude-code.ts` | 2 | 共有型 |
| `shared/eventa.ts` (claudeCode* contracts) | 2 | IPC contracts |

### 削除するコード

| ファイル / 変更 | Phase | 理由 |
|---|---|---|
| `packages/stage-ui/src/stores/llm.ts` の分岐 | 3 | chat provider 不要 |
| `renderer/providers/claude-code/` 全体 | 3 | chat provider 不要 |
| `renderer/pages/settings/providers/chat/claude-code.vue` | 5 fix | chat 設定ページ不要 |
| `renderer/main.ts` の `import './providers/claude-code'` | 3 | side-effect import 不要 |
| `extraMethods.listModels` (合成モデル) | fix | consciousness store 不要 |
| window RPC の `broadcastStreamEvents` | fix | speech bridge が直接 subscribe |

---

## New-1: Cleanup + TextFilter

**目的**: チャット統合の残骸を削除し、テキスト浄化ユーティリティを新規作成。

### 1A: Cleanup (chat provider 削除)
- [ ] `packages/stage-ui/src/stores/llm.ts` — `isClaudeCodeChatProvider` / `AIRI_CLAUDE_CODE_STREAM_METHOD` / `streamFrom` 内の分岐を削除
- [ ] `apps/stage-tamagotchi/src/renderer/providers/claude-code/` — ディレクトリごと削除
- [ ] `apps/stage-tamagotchi/src/renderer/pages/settings/providers/chat/claude-code.vue` — 削除
- [ ] `apps/stage-tamagotchi/src/renderer/main.ts` — `import './providers/claude-code'` 行を削除
- [ ] `apps/stage-tamagotchi/src/main/windows/main/rpc/index.electron.ts` — `broadcastStreamEvents: true` → `broadcastStreamEvents` パラメータ自体を削除（後で speech bridge 側で制御）
- [ ] `electron-service.ts` — `broadcastStreamEvents` option 削除、stream forwarder を常に登録に戻す（speech bridge の subscribe 先として必要）
- [ ] typecheck + lint + test pass 確認

### 1B: TextFilter (テキスト浄化)
- [ ] `apps/stage-tamagotchi/src/main/services/airi/claude-code/text-filter.ts` 新規
  - `cleanTextForSpeech(text: string): string` — Markdown/コード/URL 除去
  - `splitIntoSentences(text: string): string[]` — 文単位分割
- [ ] `text-filter.test.ts` TDD
  - コードブロック除去 (```...```)
  - インラインコード除去 (`...`)
  - XML/HTML タグ除去
  - Markdown 見出し (#, ##) 除去
  - URL 除去
  - テーブル構文除去 (|...|)
  - リストマーカー除去 (-, *)
  - git ハッシュ除去 (7-40文字 hex)
  - 日本語句点 (。!？) / 英語ピリオド (.!?) での文分割
  - 空文字列 / 空白のみ → 空配列

### 品質ゲート
- [ ] typecheck pass
- [ ] 既存テスト全 pass（削除による退行なし）
- [ ] textFilter テスト pass
- [ ] lint clean

---

## New-2: Speech Bridge + 設定簡素化

**目的**: SessionWatcher の assistant-text イベントを Airi の TTS パイプラインに接続。

### 2A: ClaudeCodeSpeechBridge
- [ ] `apps/stage-tamagotchi/src/renderer/composables/use-claude-code-speech.ts` 新規
  - `useClaudeCodeSpeech(options: { projectDir, enabled })` composable
  - `claudeCodeStreamEvent` を subscribe (Eventa IPC)
  - `assistant-text` イベントのみフィルタ
  - `cleanTextForSpeech()` でテキスト浄化
  - `characterStore.emitTextOutput(cleanedText)` で読み上げトリガ
  - `enabled` ref で ON/OFF 制御
- [ ] 自動セッション追尾: `claudeCodeListSessions` で最新セッションを取得 → `claudeCodeAttachSession` で watcher 起動
- [ ] main process: `electron-service.ts` の stream broadcast を全ウインドウに常時有効化（broadcastStreamEvents 削除済み前提）

### 2B: 設定ページ簡素化
- [ ] `claude-code.vue` を「読み上げモード」用に改修
  - projectDir フィールド: 残す
  - binaryPath フィールド: 残す
  - sessionId フィールド: 削除（自動追尾に変更）
  - 「読み上げ ON/OFF」トグル追加
- [ ] i18n キー調整（不要なフィールドラベル削除、トグルラベル追加）

### 品質ゲート
- [ ] dev build で読み上げ動作確認
- [ ] typecheck + test pass
- [ ] ターミナルで `claude` を実行 → 応答をキャラが読み上げる

---

## New-3: 統合テスト + 検証

- [ ] 手動検証: ターミナルで claude → Airi キャラが読み上げ
- [ ] 手動検証: claude がコードを書く → コードブロックは読み上げない
- [ ] 手動検証: 読み上げ OFF → 沈黙
- [ ] デバッグログ除去
- [ ] PLAN.md 最終更新
- [ ] コミット

