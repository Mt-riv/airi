# PLAN.md

Claude Code × Airi フォークの実装計画。本ドキュメントは「実装済み機能 / 残存課題 / 次の開発計画」のみを保持する。
詳細な実績ログ・設計議論は `PLAN.archive-2026-04-18.md` および `git log PLAN.md` を参照。

最終更新: 2026-04-18

---

## 1. 実装済み機能

### 1.1 Claude Code 統合 (Phase 0–6)
- **JSONL tail パイプライン**: `~/.claude/projects/<slug>/<session>.jsonl` を追尾して assistant テキストを抽出し、TTS へ流す。main ⇄ renderer は eventa RPC で接続。
- **Chat-Parallel (CP-1〜3)**: Airi チャット入力と Claude Code TUI を同一ウィンドウで並走。`message.id` による dedupe と、未確定 assistant snapshot 抑止。
- **設定 UI**: `packages/stage-pages/src/pages/settings/modules/claude-code.vue` から有効/無効・プロジェクトパス切替。

### 1.2 Speech Providers (VV-A 〜 VV-C)
- **VOICEVOX / AivisSpeech** プロバイダを `packages/stage-ui/src/stores/providers/providers/` 配下に追加。
- 設定画面は `packages/stage-pages/src/pages/settings/modules/` にあり、`isConfigured` を訪問時にマーク。

### 1.3 OC-Features Agent Runtime (OC-AG-1〜8)
- **packages/agent-runtime**: `createAgentHarness` / `runAttempt` / `handleToolCall` / `evaluateSensitivity` / `createInteractiveApprovalGate` (per-turn スコープ `approvalGatesByTurn: Map<turnId, gate>`)。
- **packages/skill-registry**: SKILL.md ローダとトリガーベースレジストリ。
- **packages/cron-runtime**: 単一タイマー方式の `createCronScheduler`、`createJsonJobStore`、`createFakeClock`。
- **Option A 配線**: main が永続化・cron を保持し、renderer がターン実行。`apps/stage-tamagotchi/src/main/services/airi/{agent,skills,cron}` と `packages/stage-ui/src/stores/modules/agent-runtime.ts` がハブ。
- **UI**: 承認モーダル `apps/stage-tamagotchi/src/renderer/components/agent/approval-modal.vue`、devtools `pages/devtools/agent-runs.vue`、設定 `settings/modules/agent-runtime.vue`。
- **ドキュメント**: `docs/integrations/agent-runtime.md`、`skill-authoring-guide.md`、`agent-runtime-security.md`。
- **opt-in 統合テスト**: `apps/stage-tamagotchi/test/integration/agent-runtime.test.ts`（`AIRI_TEST_AGENT_RUNTIME=1`）。

### 1.4 テスト基盤
- `packages/stage-ui` / `packages/stage-ui-live2d` / `apps/stage-tamagotchi` 各 workspace に `vitest.config.ts` を整備。全 6 件のプリ既存失敗テストを 2026-04-18 に解消済み（plugins 4 件 = `permissions` 必須フィールド補完、execute-tool = `ToolExecutionError.cause` 検証、use-vision-inference = `timeoutMs` オプション化）。

---

## 2. 残存課題

### 2.1 Claude Code 統合
- (解消済: Phase 7 ユーザーガイド `docs/integrations/claude-code.md` を 2026-04-18 に追加)
- 通知音・速度プリセットなどの UX 微調整要望 (= 読み上げモード New-1〜3 完了後のバックログ) は **§3 Priority 2 P2-B** に一本化。

### 2.2 OC-Features Agent Runtime
- (解消済: `createJsonJobStore` の atomic write + クラッシュ復旧シナリオテストを 2026-04-18 に追加)

### 2.3 横断・基盤
- **Local Whisper 音声入力**: `packages/stage-ui/src/libs/workers/worker.ts` に whisper-large-v3-turbo の WebGPU ワーカー実装はあるが、プロバイダレジストリ (`stores/providers.ts`) に未登録。Priority 1 (LW-1〜5) として着手予定。
- (解消済: `@eslint/plugin-kit` を 0.6.1 に override + `PLAN*.md` を lint ignore で `pnpm lint` 全走査復旧、2026-04-18)
- (解消済: `parseDataUrl` の正規表現をモジュールトップに昇格、2026-04-18)

---

## 3. 次の開発計画

### Priority 1: Local-Whisper 統合 (LW-1〜5)

既存 WebGPU ワーカーを音声入力プロバイダとして組み込み、オフライン STT を解放する。

- **LW-1 プロバイダ登録**: `packages/stage-ui/src/stores/providers.ts` に `local-whisper` プロバイダを追加。モデル一覧は固定 (`whisper-large-v3-turbo`) からスタート。
- **LW-2 composable 整備**: `composables/speech/use-local-whisper.ts` を新設し、worker メッセージング (load / transcribe / abort) をラップ。VueUse `useWebWorker` を流用。
- **LW-3 Hearing 連携**: `stores/modules/hearing` から既存 STT プロバイダと同列に切替可能にする。
- **LW-4 設定 UI**: `packages/stage-pages/src/pages/settings/modules/hearing-local-whisper.vue`。モデルダウンロード進捗、WebGPU 対応チェック、言語選択。
- **LW-5 テスト**: worker は jsdom で直接テスト困難なので `vi.mock` でメッセージ往復を検証。`AIRI_TEST_LOCAL_WHISPER=1` で opt-in の実機テストを追加。

### Priority 2: UX / 運用改善

- **P2-B 読み上げプリセット**: New-1〜3 バックログ（速度 / 声質 / 通知音）を設定モジュール化。
- **P2-C Agent Runtime 承認モーダル自動テスト**: まずは既存 node-vitest + `@testing-library/vue` で承認モーダルコンポーネントの smoke テスト (表示・allow/deny イベント) を追加。Vitest browser / Playwright への本格 E2E は LW-* と同列の拡張タスクとして後続。

> P2-A (Phase 7 ドキュメント) / P2-D (cron 電源断シナリオテスト) / P2-E (ESLint 全走査復旧) / P2-F (`parseDataUrl` lint) は 2026-04-18 に完了したため除去。

### Priority 3: 拡張機能 (P3-A 〜 P3-C)

- **P3-A Claude Code 複数セッション UI**: 現状は単一セッション tail。プロジェクト別のタブ切替を renderer に追加。
- **P3-B Agent Runtime スキル配布**: SKILL.md パッケージをプラグイン経由で配布できるよう `packages/plugin-sdk` のマニフェストに `skills` フィールドを追加（`permissions` と同様に Valibot で schema 定義）。
- **P3-C Speech Provider のストリーミング最適化**: VOICEVOX / AivisSpeech の合成レイテンシを計測し、文節単位チャンク化を検討。

---

## 4. 非破壊性チェックリスト

新機能追加時は以下を満たすこと。

1. **フィーチャーフラグ**: `settings.*.enabled` か同等のフラグで無効化可能にする。デフォルト OFF で既存挙動を変えない。
2. **既存プロバイダへの影響ゼロ**: `stores/providers.ts` に追加する際、既存プロバイダの型・optional 性を壊さない。
3. **main/renderer 契約**: Eventa contract を `apps/stage-tamagotchi/src/shared/eventa.ts` に集約し、renderer のみで完結できる場合は main 側を触らない。
4. **Valibot schema 互換**: マニフェスト / 設定 schema を拡張する際は optional フィールドから始め、既存ユーザのファイルが破綻しないことを確認。
5. **テスト追加**: 新規機能は最低 1 件のユニットテスト + 該当 workspace の `vitest run` が green。

---

## 5. 参考リンク

- Claude Code JSONL: `apps/stage-tamagotchi/src/main/services/airi/claude-code/`
- Agent Runtime: `docs/integrations/agent-runtime.md`
- Skill Authoring: `docs/integrations/skill-authoring-guide.md`
- Agent Runtime Security: `docs/integrations/agent-runtime-security.md`
- 過去の詳細計画・実績ログ: `PLAN.archive-2026-04-18.md`
- 手動検証手順: `docs/integrations/agent-runtime.md#手動検証` ほか各 integration ドキュメント
