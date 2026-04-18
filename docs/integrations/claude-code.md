# Claude Code × Airi — 統合ユーザーガイド

> **対象読者**: Airi デスクトップ (stage-tamagotchi) で Anthropic の Claude Code CLI を併走させたい利用者、および設定 UI / 読み上げ機能 / チャットミラー機能の動作を理解したい開発者。
> **スコープ**: セットアップ、設定項目の意味、並走時のメッセージ dedupe の仕組み、セッション切替の考え方、トラブルシュート。
> **関連**: `docs/integrations/claude-code-manual-verification.md` (リリース前の手動検証チェックリスト) / `docs/integrations/claude-code-jsonl-schema.md` (JSONL 取り込みの内部スキーマ) / `docs/integrations/agent-runtime.md` (自律エージェント機能との境界)。

---

## 1. 何ができる機能か

Airi フォークの Claude Code 統合は、Anthropic の Claude Code CLI を Airi のチャットウィンドウ (+ 読み上げ + Live2D) とシームレスに繋げる機能です。以下を同時に成立させます。

- **JSONL tail パイプライン**: ターミナルで動いている `claude` TUI が書き出す `~/.claude/projects/<slug>/<session>.jsonl` を main プロセスが追尾し、assistant テキストを Airi の TTS と字幕に流す。TUI の表示順序を壊さない。
- **Chat-Parallel (CP-1〜3)**: Airi のチャット入力欄から直接 Claude Code にプロンプトを投げられる。ターミナル TUI と Airi チャットが **同じ会話履歴を共有** し、`message.id` ベースで dedupe。ストリーム途中の未確定 assistant snapshot は UI 上で抑止される。
- **設定 UI**: 設定 → モジュール → Claude Code から有効/無効・プロジェクトディレクトリを切替。`claude` バイナリの存在とプロジェクトディレクトリの可読性を非同期にバリデートして表示する。

> Airi の通常の LLM プロバイダ (xsai / OpenAI / Anthropic API など) と **排他ではない**。Claude Code を有効にしても既存プロバイダは生き続け、読み上げや Live2D も引き続き動作します。

## 2. 事前条件

1. **Claude Code CLI のインストールとログイン**:
   - `npm install -g @anthropic-ai/claude-code` または Anthropic 公式の案内に従って導入。
   - ターミナルで `claude --version` が成功し、一度 `claude` を起動してアカウント認証が完了していること。
2. **Airi デスクトップの dev / prod ビルド**:
   ```sh
   pnpm install
   pnpm -F @proj-airi/stage-tamagotchi dev     # 開発用
   # または
   pnpm -F @proj-airi/stage-tamagotchi build   # リリースビルド
   ```
3. **プロジェクトディレクトリ**:
   Claude Code CLI を通常使う git リポジトリのルート (= 追跡したい対話が発生する場所) を 1 つ決めておく。Airi 側の `projectDir` はここを指します。

## 3. 初回セットアップ

1. Airi を起動し、**設定 → モジュール → Claude Code** を開く。
2. 3 つのフィールドを設定する:
   - **Claude Code binary**: `claude` が PATH にあれば空欄で OK。カスタムビルドを使う場合のみフルパスを指定。
   - **Project directory**: 上で決めたプロジェクトルートの絶対パス。Airi はこれを元に `~/.claude/projects/<slug>/` の slug を計算し、そのディレクトリ配下の最新 JSONL を tail する。
   - **Speech enabled / Show in chat history**: 読み上げ、およびターミナル側の発話を Airi チャット履歴にミラーするかのトグル。
3. 保存。バリデータが緑になれば準備完了。赤の場合は §7 を参照。

> 設定値は `pinia-plugin-persistedstate` で永続化されます。Airi を再起動しても保持されます。

## 4. 日常的な使い方

### 4.1 ターミナル TUI 主導

1. 別ターミナルで `cd <projectDir> && claude` を起動。通常通り TUI で会話する。
2. Airi のチャットウィンドウには **同じ会話がリアルタイムに再生** される (assistant テキスト + tool-call / tool-result スライス)。
3. 読み上げが ON なら assistant テキストが TTS に流れ、Live2D が表情を取る。

### 4.2 Airi チャット主導

1. Airi チャットのプロバイダドロップダウンから **Claude Code** を選択。
2. プロンプトを入力して送信。
3. Airi が内部的に `claude -p <prompt>` を spawn し、同じ `<session>.jsonl` に追記する。ターミナル TUI が動いていれば、そちらにも同じターンが現れる。

### 4.3 双方向併走 (Chat-Parallel)

§4.1 と §4.2 を **同時に** 行うのが Chat-Parallel (CP-*) の想定ユースケース。どちらから送っても同じ JSONL に追記され、両方の UI で同じ順番で表示されます。

## 5. Message dedupe の仕組み (CP-3)

ターミナル TUI と Airi チャットが同じ JSONL を見ているため、素朴に実装すると **1 ターンが両方に 2 回表示** されます。Airi ではこれを以下で抑止しています:

- **ソース**: `~/.claude/projects/<slug>/<session>.jsonl` の各行が持つ `message.id` (Claude Code が採番する安定 ID)。
- **dedupe キー**: `message.id` が見えた時点でその ID を既出セットに登録。同じ ID の後続スナップショットは無視。
- **未確定 snapshot の抑止**: ストリーミング中に Claude Code が部分的な assistant message を書き出すことがある (`content` が途中まで)。Airi はこれを識別して確定版が届くまで UI にコミットしない。
- **実装**: `apps/stage-tamagotchi/src/main/services/airi/claude-code/session-watcher.ts` (tail + 分類) と `jsonl-to-stream-event.ts` (正規化) を参照。renderer 側は `packages/stage-ui/src/stores/modules/claude-code.ts` でこのイベント列を受ける。

## 6. セッション切替 (単一セッション tail の現状と制約)

- **現状**: `projectDir` あたり 1 本の最新セッションを tail する。ユーザーがターミナルで `claude` を **起動し直す** と新しい `<session>.jsonl` が作られ、Airi は自動でそちらに追随する。
- **制約**: 複数セッション (異なるトピックで並列に 2 本の TUI を走らせる、など) を UI から選んで切り替える機能は未実装。`PLAN.md` の「P3-A 複数セッション UI」が該当のバックログ項目。
- **回避策**: 並列セッションを触る間は、Airi 側の `projectDir` をどちらか一方に寄せるか、`Show in chat history` を一時的に切ってターミナル単独で使う。

## 7. トラブルシューティング

| 症状 | 典型的な原因 | 対処 |
|---|---|---|
| 設定ページの **Claude Code binary** が赤 | `claude` が PATH にない / カスタムパスが誤り / 実行権限なし | `which claude` で確認、必要なら絶対パスを入力 |
| 設定ページの **Project directory** が赤 | ディレクトリが存在しない / 読み取り不可 / 相対パスを渡している | `ls -l <projectDir>` を確認、必ず絶対パスを使う |
| ターミナルで会話しているのに Airi チャットに何も出ない | `projectDir` のパスが Claude Code 側と別物 / 別プロジェクト slug にヒットしている | `ls ~/.claude/projects/` で slug を確認し、`projectDir` を揃える |
| Airi から送信したプロンプトが戻らない | 既存 Claude Code TUI が同じ `projectDir` でロックを握っている / ネットワーク断 | TUI を一度閉じ、Airi だけで送って再現するか切り分け |
| 読み上げが喋らない | `Speech enabled` が OFF / TTS プロバイダ (VOICEVOX など) が停止 | 設定 → モジュール → Speech で VOICEVOX/AivisSpeech の接続を確認 |
| 同じ発話が 2 回表示される | dedupe キーである `message.id` が欠けた古い JSONL ファイル | `claude` CLI を最新化 (`npm i -g @anthropic-ai/claude-code`) |
| ストリーム途中で固まる | Claude Code 子プロセスがハング / SIGTERM 無視 | ターミナルで `pgrep -f 'claude -p'` → `kill -9 <pid>`。Airi は自動回復する |

より詳しい再現手順は `docs/integrations/claude-code-manual-verification.md` の各シナリオを参照してください。

## 8. 関連するファイル

- main プロセス側 orchestrator: `apps/stage-tamagotchi/src/main/services/airi/claude-code/index.ts`
- JSONL tail: `apps/stage-tamagotchi/src/main/services/airi/claude-code/session-watcher.ts`
- Claude Code プロセス spawn: `apps/stage-tamagotchi/src/main/services/airi/claude-code/session-runner.ts`
- バイナリ可用性チェック: `apps/stage-tamagotchi/src/main/services/airi/claude-code/binary-prober.ts`
- プロジェクト slug 計算: `apps/stage-tamagotchi/src/main/services/airi/claude-code/project-slug.ts`
- 正規化 (JSONL → StreamEvent): `apps/stage-tamagotchi/src/main/services/airi/claude-code/jsonl-to-stream-event.ts`
- 設定 UI: `packages/stage-pages/src/pages/settings/modules/claude-code.vue`
- renderer 側 store / 読み上げ: `packages/stage-ui/src/stores/modules/claude-code.ts`、`apps/stage-tamagotchi/src/renderer/composables/use-claude-code-speech.ts`
- Eventa contract: `apps/stage-tamagotchi/src/shared/eventa.ts` (`claudeCode*` イベント)

## 9. 既知の非対応 / 今後の予定

`PLAN.md` の **Priority 2 / 3** に残っている関連項目:

- **P2-A**: 本ドキュメント自体 (完了時にこの節を削除)。
- **P2-B**: 読み上げプリセット (速度 / 声質 / 通知音)。現状は VOICEVOX / AivisSpeech の既定設定をそのまま使用。
- **P3-A**: 複数セッションの UI 切替 (§6 参照)。
- **P3-C**: VOICEVOX / AivisSpeech の合成レイテンシを文節単位チャンクで最適化。

これらを実装するときは **非破壊性チェックリスト** (`PLAN.md` §4) に沿って、既定 OFF のフラグで導入してください。
