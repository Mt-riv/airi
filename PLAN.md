# Claude Code × Airi 統合 実装計画

> **目的**: Airi のチャットウインドウを Claude Code CLI のフロントエンドとして機能させる。
> 1. Claude Code TUI で進行中の会話履歴を Airi チャットにミラーする
> 2. Airi チャットからプロンプトを送信し、同一セッションに追記できる
>
> **対象**: `apps/stage-tamagotchi` (Electron) のみ。`stage-web` / `stage-pocket` は対象外。
> **方針**: ヘッドレス `claude -p --resume <id>` + JSONL tail のハイブリッド経路。Agent SDK 直叩きはしない（既存 TUI にアタッチできないため）。
> **開始日**: 2026-04-08
> **最終更新**: 2026-04-08

---

## 進捗ダッシュボード

| Phase | 概要 | 状態 | 完了日 | 備考 |
|---|---|---|---|---|
| Phase 0 | リサーチ検証 & POC | ✅ 完了 | 2026-04-08 | JSONL スキーマ確定 / POC tail 動作 |
| Phase 1 | Electron main: ClaudeCodeService | ⬜ 未着手 | — | TDD |
| Phase 2 | Eventa IPC コントラクト | ⬜ 未着手 | — | — |
| Phase 3 | Airi Provider として登録 | ⬜ 未着手 | — | — |
| Phase 4 | i18n | ⬜ 未着手 | — | en / ja / zh-Hans |
| Phase 5 | UI: 設定 & セッションセレクタ | ⬜ 未着手 | — | — |
| Phase 6 | テスト & 品質 | ⬜ 未着手 | — | 80%+ カバレッジ |
| Phase 7 | ドキュメント | ⬜ 未着手 | — | README × 3 |

**状態凡例**: ⬜ 未着手 / 🟨 進行中 / ✅ 完了 / 🟥 ブロック

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
- [ ] `index.ts` — injeca 登録、`start/stop/listSessions/resumeSession/sendPrompt/onEvent` API
- [ ] `session-watcher.ts` — `chokidar` で JSONL tail、行パース、正規化イベント emit
- [ ] `session-runner.ts` — `execa` で `claude -p` spawn、stdout 行パース
- [ ] `jsonl-to-stream-event.ts` — 純関数: Claude Code JSONL → Airi `StreamEvent`
- [ ] `project-slug.ts` — cwd → `~/.claude/projects/<slug>` 名規則を再現
- [ ] `types.ts` — `ClaudeCodeEvent`, `ClaudeCodeSession`, `ClaudeCodeSessionMeta`

### テスト（TDD: 先に赤テストを書く）
- [ ] `jsonl-to-stream-event.test.ts` — サンプル行 → 期待 StreamEvent 配列
- [ ] `project-slug.test.ts` — 境界ケース（空白 / 日本語 / シンボリックリンク）
- [ ] `session-watcher.test.ts` — tmp ディレクトリに書き込み、`vi.fn` で emit 観測
- [ ] `session-runner.test.ts` — `vi.mock('execa')`、stdout にサンプル JSON 投入
- [ ] `index.test.ts` — injeca インジェクション確認

### 依存追加（Phase 0 の調査結果次第）
- [ ] `execa` (必要なら)
- [ ] `chokidar` (必要なら)

### 品質ゲート
- [ ] `pnpm -F @proj-airi/stage-tamagotchi typecheck` pass
- [ ] `pnpm -F @proj-airi/stage-tamagotchi exec vitest run` 新規テスト全 pass
- [ ] カバレッジ 80%+

### 実績ログ
<!-- -->

---

## Phase 2: Eventa IPC コントラクト

**目的**: main ↔ renderer の型安全な通信チャネルを定義。

### ファイル
- [ ] `apps/stage-tamagotchi/src/shared/eventa.ts` に以下を追加:
  - [ ] `claudeCodeListSessions: defineInvokeEventa<ClaudeCodeSession[]>`
  - [ ] `claudeCodeStartResume: defineInvokeEventa<{ sessionId: string }, { sessionId?: string; cwd: string }>`
  - [ ] `claudeCodeSendPrompt: defineInvokeEventa<{ ok: true } | { ok: false; error: string }, { sessionId: string; text: string }>`
  - [ ] `claudeCodeStopSession: defineInvokeEventa<void, { sessionId: string }>`
  - [ ] `claudeCodeStreamEvent: defineEventa<{ sessionId: string; event: NormalizedStreamEvent }>`
  - [ ] `claudeCodeSessionChanged: defineEventa<{ sessionId: string; meta: ClaudeCodeSessionMeta }>`
- [ ] `apps/stage-tamagotchi/src/main/windows/chat/rpc/claude-code.electron.ts` 新規作成（ハンドラ束ね）
- [ ] `apps/stage-tamagotchi/src/main/windows/chat/rpc/index.electron.ts` から呼び出し追加

### 品質ゲート
- [ ] 型が renderer 側からも import できる
- [ ] typecheck pass

### 実績ログ
<!-- -->

---

## Phase 3: Airi Provider として登録

**目的**: Airi のプロバイダ登録機構に `claude-code` を追加し、チャットから選択できるようにする。
**配置**: `packages/stage-ui/src/libs/providers/providers/claude-code/`

### ファイル
- [ ] `index.ts` — `defineProvider<ClaudeCodeConfig>({ id: 'claude-code', tasks: ['chat'], icon: 'i-simple-icons:anthropic', ... })`
- [ ] `config.ts` — Zod schema: `binaryPath`, `projectDir`, `sessionId?`, `autoAttach`。`z.meta({ labelLocalized, ... })` 付き
- [ ] `provider.ts` — `createProvider` 戻り値。`message(messages, options)` で Eventa invoke → `onStreamEvent` に配管
- [ ] `packages/stage-ui/src/libs/providers/providers/index.ts` に `import './claude-code'` 追加

### アダプタ実装の要点
- [ ] 既存 `@xsai` プロバイダの `chat.completions.create` 風 async iterable インタフェースを模倣
- [ ] Eventa `claudeCodeStreamEvent` の subscribe を provider インスタンスで管理、message ごとに同一セッションをフィルタ
- [ ] tool_name はそのまま通す（既存 `tool-call-block.vue` が描画）

### バリデータ
- [ ] `validators.validateConfig` で `binaryPath` の実在確認（`which claude` 相当を main 経由で）
- [ ] 設定画面で赤字警告が出ることを目視確認

### テスト
- [ ] `provider.test.ts` — Eventa をモックしストリーム合流を検証
- [ ] `config.test.ts` — Zod schema の境界テスト

### 品質ゲート
- [ ] `pnpm -F @proj-airi/stage-ui typecheck` pass
- [ ] `pnpm -F @proj-airi/stage-ui exec vitest run` pass
- [ ] チャット画面のプロバイダセレクタに "Claude Code" が表示される

### 実績ログ
<!-- -->

---

## Phase 4: i18n

**目的**: 設定画面の文言を多言語化。
**配置**: `packages/i18n/src/locales/*/settings.yaml`

### 対象ロケール
- [ ] `en` (mandatory)
- [ ] `ja` (mandatory)
- [ ] `zh-Hans` (mandatory)
- [ ] その他既存ロケール (best-effort, 空値 fallback)

### キー構造（例）
```yaml
settings:
  pages:
    providers:
      provider:
        claude-code:
          title: Claude Code
          description: Bridge Airi chat with Anthropic's Claude Code CLI
          fields:
            binary-path:
              label: Claude Code binary
              placeholder: /usr/local/bin/claude
              description: Path to the `claude` executable
            project-dir:
              label: Project directory
              placeholder: /Users/you/your-project
              description: cwd passed to Claude Code (maps to ~/.claude/projects/<slug>)
            auto-attach:
              label: Auto-attach to latest session
              description: Mirror the most recent running TUI session
```

### タスク
- [ ] en キー追加
- [ ] ja キー追加
- [ ] zh-Hans キー追加
- [ ] 他ロケールは en fallback 確認

### 実績ログ
<!-- -->

---

## Phase 5: UI — 設定ページ & セッションセレクタ

**目的**: プロバイダ設定画面と、チャット画面でのセッション切り替え UI を整える。

### 5.1 設定ページ
- [ ] Zod schema の自動フォーム化で動作することを確認（追加コード不要が理想）
- [ ] `binaryPath` 未設定時の警告表示
- [ ] `projectDir` に対応する slug のプレビュー表示

### 5.2 セッションセレクタ（optional, 余裕があれば）
- [ ] `packages/stage-ui/src/components/scenarios/chat/claude-code-session-switcher.vue` 新規
- [ ] チャットヘッダに現在セッション ID を表示
- [ ] 「最新の TUI セッションに接続」ボタン
- [ ] セッション一覧ドロップダウン

### 品質ゲート
- [ ] 設定画面で値を変更 → 永続化 → 再起動後も保持される
- [ ] プロバイダ切り替えでチャット履歴がリセットされない

### 実績ログ
<!-- -->

---

## Phase 6: テスト & 品質

**目的**: 80%+ カバレッジ + 統合テスト + 手動検証。

### 自動テスト
- [ ] Phase 1 ユニットテスト群 pass
- [ ] Phase 3 provider テスト pass
- [ ] **統合テスト** `apps/stage-tamagotchi/src/main/services/airi/claude-code/integration.test.ts`
  - [ ] `process.env.AIRI_TEST_CLAUDE_CODE === '1'` でのみ実行
  - [ ] 実 `claude -p "2+2"` を spawn し正規化イベントが emit されることを確認
- [ ] カバレッジレポートで 80%+ を確認

### 手動検証シナリオ
- [ ] **シナリオ A**: ターミナルで `claude` を起動 → 数ターン会話 → Airi を起動 → 同一セッションの履歴が Airi に表示される
- [ ] **シナリオ B**: Airi のチャット入力から送信 → ターミナル側の TUI にも同じメッセージが現れ、Claude の返答が両方に流れる
- [ ] **シナリオ C**: Airi から送信 → tool call (Bash) が発生 → `tool-call-block.vue` で描画される
- [ ] **シナリオ D**: `binaryPath` を不正値に設定 → バリデータが警告を表示
- [ ] **シナリオ E**: Claude Code プロセスを途中で kill → Airi 側が error イベントを受け取り UI に反映

### 品質ゲート（コミット前必須）
- [ ] `pnpm typecheck` pass
- [ ] `pnpm lint:fix` で差分なし
- [ ] `pnpm test:run` pass
- [ ] security review: ファイルパス sanitize、コマンドインジェクション対策確認

### 実績ログ
<!-- -->

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
