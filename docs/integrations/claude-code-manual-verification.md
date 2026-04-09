# Claude Code × Airi — 手動検証チェックリスト

> **対象読者**: Claude Code 統合のリリース候補をカットする人、または main プロセスのサービス・renderer のプロバイダ・チャット UI の配線に触れる PR をレビューする人。
> **スコープ**: 自動テストスイート（`apps/stage-tamagotchi/src/main/services/airi/claude-code/*.test.ts` および `apps/stage-tamagotchi/src/renderer/providers/claude-code/*.test.ts` を参照）だけでは担保できない、目視検証 + エンドツーエンドのチェック。
> **事前条件**:
>
> - Claude Code CLI がインストール済みでログイン済み
>   （ターミナルで `claude --version` が成功すること）。
> - Airi の dev ビルドが準備済み: `pnpm install && pnpm -F @proj-airi/stage-tamagotchi dev`。
> - `AIRI_TEST_CLAUDE_CODE=1` は **設定しない** — このガイドは実アプリのウォークスルーであり、統合テストの gate とは別物。

## 使い方

各シナリオは **セットアップ**、**手順**、**期待される振る舞い** をセクションごとに列挙している。リリース前に macOS 上で上から順に実行すること。各シナリオは PR チェックリストまたはリリースノートで ✅ / ❌ / ⚠️ を記入する。

---

## シナリオ A — 既存 TUI セッションを Airi にミラー

> JSONL tail 経路（`SessionWatcher` + renderer プロバイダの backfill）を検証する。
> 注意: Phase 3 は送信のみの出荷であり、ミラー機能は後続フェーズのセッションスイッチャー UI 到着待ち。そのフェーズが届くまでこのシナリオは **ブロック** 状態として扱い、将来のセッションで再訪できるようチェックリストだけ残している。

1. 普通のターミナルを開き、airi リポジトリのルートで `claude` を実行する。
2. Claude に 2〜3 メッセージ質問する（例: `list the files here`、`summarise package.json`）。それぞれの返答を待つ。
3. TUI ヘッダに表示されたセッション UUID を控える。
4. Airi を起動する（`pnpm -F @proj-airi/stage-tamagotchi dev`）。
5. **設定 → プロバイダ → Claude Code** を開く。`projectDir` を airi リポジトリのルートに設定する。保存。
6. チャットを開く。セッションスイッチャー UI が到着するまでの暫定手段として、renderer の devtools コンソールを開いて以下を実行:
   ```js
   // eventa context はプロバイダによって lazy import される。
   // 最も簡単な方法は Airi の診断パネルから listSessions を呼ぶこと。
   ```

**期待動作**: 実装されれば、Airi のチャットパネルがターミナルの会話ターン（user text + assistant text + tool-call ブロック）を同じ順序かつ同じ UUID で再生するはず。

**ステータス**: ⚠️ 保留 — Phase 5 の follow-up（セッションスイッチャー）待ち。

---

## シナリオ B — Airi からプロンプト送信、ラウンドトリップを確認

> 送信経路（`claudeCodeSendPrompt` 経由の `SessionRunner`）と stream-event の forward を検証する。

1. 対象 project dir で他の Claude Code TUI が動いていないことを確認する。
2. Airi で設定 → プロバイダ → Claude Code を開く。バリデータが **valid** を報告すること（バイナリチェック + project-dir 解決の両方が緑）を確認する。
3. チャットを開く。プロバイダドロップダウンから **Claude Code** を選択する。
4. `say hi in three words` と入力して送信する。

**期待動作**:
- ✅ ユーザーメッセージが即座に Airi チャット履歴に表示される。
- ✅ 約 5 秒以内に、アシスタントの返答が text delta としてストリーミング表示される。
- ✅ 返答に tool-call スライスが **含まれない**（必要ないため）。
- ✅ Claude Code バイナリが、設定した `projectDir` に対応する `~/.claude/projects/<slug>/<uuid>.jsonl` に新しいファイルを書き込む。
- ✅ 同じチャットセッションで 2 通目のメッセージを送信すると、**同じ** JSONL ファイルに追記される（`wc -l` でファイルが成長したことを確認）。

**ステータス**: ☐ 未検証。

---

## シナリオ C — アシスタントが Bash tool call を使う

> 既存の `tool-call-block.vue` コンポーネント経由で tool-call / tool-result スライスの描画を検証する。

1. シナリオ B の事前条件を満たしていること。
2. Airi チャットで `list the top-level files in my project directory` を送信する。

**期待動作**:
- ✅ アシスタントが `toolName: 'Bash'` かつ `ls` スタイルの input を持つ `tool-call` スライスを emit し、`tool-call-block.vue` で描画される。
- ✅ 直後に `tool-result` スライスがコマンド出力を表示する。
- ✅ アシスタントが、列挙されたファイルを参照する summary text delta で finish する。
- ✅ Airi はツール承認を求めない — Claude Code が CLI 側で自身のツール sandboxing を担当しているため。

**ステータス**: ☐ 未検証。

---

## シナリオ D — 不正な binaryPath でバリデータが警告

> 非同期 `claudeCodeCheckBinary` プローブと i18n エラー行を検証する。

1. 設定 → プロバイダ → Claude Code を開く。
2. **Claude Code binary** を `/nope/claude`（または存在しない任意のパス）に変更する。`projectDir` は有効なディレクトリのままにする。
3. バリデータをトリガする（Airi はビルドによって保存時またはフィールド変更時に実行する）。

**期待動作**:
- ✅ `check-config` のバリデータ行が約 1 秒以内に赤くなる。
- ✅ エラーメッセージは、現在のロケール（英語 / 日本語 / 简体中文）に応じて `settings.pages.providers.provider.claude-code.errors.binary-not-found` のローカライズ版となる。
- ✅ `claude` に戻すと、アプリを再起動せずに行が再び緑になる。
- ✅ `projectDir` を存在しないパスに設定すると、別のエラー行が `errors.project-dir-unreadable` にマップされて表示される — 2 つのエラーは独立してスタックする。

**ステータス**: ☐ 未検証。

---

## シナリオ E — ストリーム途中で Claude Code プロセスを kill

> `{ ok: false }` エラー伝播をエンドツーエンドで検証する。

1. シナリオ B の事前条件を満たしていること。介入する時間を確保するため、長めのプロンプト（`write a 1000-word essay about otters`）を送信する。
2. アシスタントがまだストリーミング中に、子プロセスを探す:
   ```sh
   pgrep -f 'claude -p' | head
   ```
3. `kill -TERM <pid>` を実行する（プロセスが SIGTERM を無視する場合は `kill -9`）。

**期待動作**:
- ✅ kill の直後に Airi チャットが `error` イベント / 赤色スライスを surface する — 無限スピナーにならない。
- ✅ UI は引き続き反応する。同じプロバイダインスタンスでの次のメッセージは依然として動作する（ディスパッチャが自動回復し、現在の session id が破棄されていれば `--resume` なしで新しい子を spawn する）。
- ✅ `claude -p` のゾンビプロセスが残っていない（`pgrep -f 'claude -p'` が空を返す）。

**ステータス**: ☐ 未検証。

---

## セキュリティレビュー チェックリスト

`main/services/airi/claude-code/` に触れる全 PR で以下を確認する:

- [ ] **コマンドインジェクション**: `claude` は常に配列形式の args と `shell: false` で spawn される。`spawn` 呼び出しに文字列連結が混入していないことを確認する。`session-runner.ts` と `binary-prober.ts` を参照。
- [ ] **パスエスケープ**: `projectDir` は Claude Code に渡す前、または slug にハッシュ化する前に `fs.realpath` で解決される。NUL バイトは明示的に拒否される。
- [ ] **タイムアウト**: `checkBinary` には 5 秒のハードタイムアウトがあり、ハングしたバイナリが設定フォームを固めないことを保証する。
- [ ] **JSONL サイズ**: `SessionWatcher` の cursor はファイルサイズ全体を read window として使用する。Phase 0 で観測した 130 kB+ のツール出力を途切れさせる per-line cap が存在しないことを確認する。
- [ ] **シークレット漏洩**: stream-event の raw payload をそのまま log する箇所がないことを確認する — ユーザーのプロンプトやツール出力には認証情報が含まれ得る。`useLogg` はメタデータ（session id、kind）のみを log すべき。

## 永続化 & UX チェックリスト

- [ ] 設定 → プロバイダ → Claude Code に入力した値が、アプリ再起動後も保持される（Airi はプロバイダ設定に pinia-plugin-persistedstate を使用）。
- [ ] Claude Code から別のプロバイダに切り替え、戻ってきたとき、Airi のチャット履歴スクロールバックが維持される — ディスパッチャの状態は破棄されるが、永続化されたメッセージは残るべき。
- [ ] 言語切り替え（設定 → 一般 → 言語）で、バリデータのラベルとフィールド説明が即座に新しいロケールで再レンダリングされる。

---

## リリースゲーティング

Claude Code 統合に触れる PR が **マージ可能** な条件:

- 上記 5 シナリオ全てが ✅ となっている（または ⚠️ の場合は follow-up issue へのリンク付きで明示的に deferred となっている）。
- セキュリティレビュー チェックリストが全てチェック済。
- 自動テストスイートが pass: `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/renderer/providers/claude-code/ src/main/services/airi/claude-code/`。
- オプション: `AIRI_TEST_CLAUDE_CODE=1 …` の統合テストが現在の Claude Code CLI ビルドに対して pass する。
