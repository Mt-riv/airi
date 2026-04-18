# Agent Runtime セキュリティモデル

> **対象読者**: agent runtime を production 向けに運用 / 拡張するエンジニア、セキュリティレビューを通す人、SKILL.md の allow-list 設計を任される人。
> **スコープ**: ツール呼び出しの感度分類、承認ゲート (`ApprovalGate`) 契約、`AllowList` によるバイパス、abort / timeout の挙動、設計上のガード。
> **関連**: `docs/integrations/agent-runtime.md` (runtime 全体像) / `docs/integrations/skill-authoring-guide.md` (SKILL.md に allow-list を書く側の観点)。

---

## 1. 脅威モデル

Airi の agent runtime は **ローカル PC で走る自律エージェント** を前提にしている。想定する脅威は以下。

| 脅威 | 例 | 対策レイヤー |
|---|---|---|
| 誤認識による危険なツール呼び出し | LLM が `shell.exec` に `rm -rf ~` を渡す | sensitivity + approval gate |
| 継続的な副作用 | cron で毎分ネットワーク POST が走る | `setEnabled(false)` + cron broadcast の enable 判定 |
| 悪意ある SKILL.md | `allowed.shellCommands: ["*"]` で全 shell コマンドを allow-list に通す | SKILL.md のレビュー + allow-list 設計指針 |
| Resource exhaustion | LLM が無限にツール呼び出しする | `maxToolCalls` (既定 20) で打ち切り |
| 承認タイムアウトの放置 | 承認モーダルを閉じ忘れてターンが固まる | `createInteractiveApprovalGate({ timeoutMs })` + per-turn gate クリーンアップ |

**対象外**: 悪意ある LLM プロバイダからの API 応答捏造、Electron renderer プロセスから main プロセスへの direct syscall 侵害、OS レベルの permission escalation。これらは Electron の `contextIsolation` / IPC 契約 / OS の責務領域に任せる。

## 2. 感度分類の仕組み

`evaluateSensitivity(toolName, input, allowed?)` は純粋関数で、与えられた tool 名 / 入力 / allow-list から「承認が要るか」を判定する。ソース: `packages/agent-runtime/src/sensitivity.ts`。

### 2-1. カテゴリとプレフィックス

| カテゴリ | プレフィックス | 検査する入力フィールド | allow-list キー | reason ラベル |
|---|---|---|---|---|
| network | `network` | `host`, `url`, `target`, `address` | `networks` | `network` |
| filesystem.write | `filesystem.write` | `path`, `file`, `destination`, `dest` | `filesystemWrites` | `filesystem.write` |
| shell | `exec`, `shell` | `command`, `cmd`, `args` | `shellCommands` | `shell/exec` |

### 2-2. プレフィックスマッチのルール

```ts
function matchesPrefix(toolName: string, prefix: string): boolean {
  return toolName === prefix || toolName.startsWith(`${prefix}.`)
}
```

- `exec` にマッチするのは **`exec` 完全一致** または **`exec.foo` 形式** のみ
- `exec-simulator` や `executor.spawn` などはマッチしない (意図しないツール名の巻き込みを防ぐ)
- 同様に `network` は `network` / `network.request` はマッチするが `networking` はマッチしない

### 2-3. 結果のセマンティクス

| 判定 | `requiresApproval` | `reason` |
|---|---|---|
| カテゴリにマッチしない | `false` | — |
| カテゴリにマッチ、かつ allow-list に一致 | `false` | — |
| カテゴリにマッチ、allow-list に入っていない or 未指定 | `true` | `"<label> tool '<name>' requires approval"` |

**重要**: allow-list が未定義 / 空配列のときは **全件承認必須**。`allowed: {}` と書いたら `shell.exec` は毎回モーダルが出る。allow-list は **opt-in** のバイパス機構。

## 3. `AllowList` の構文

```ts
export interface AllowList {
  networks?: string[]
  filesystemWrites?: string[]
  shellCommands?: string[]
}
```

### 3-1. パターンマッチ

```ts
function matchesPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1))
  }
  return value === pattern
}
```

- `pattern` 末尾が `*` → プレフィックス一致
- それ以外 → 完全一致
- 正規表現やグロブ (`?`, `[]`, `{}`) はサポートしない (副作用が見えにくく攻撃面が増えるため)

### 3-2. value の抽出順

`evaluateSensitivity` は `input` を `Record<string, unknown>` として扱い、カテゴリごとの `inputFields` を **先頭から順に** 走査して最初に出現した string 値を採用する。

```ts
// network の場合、host → url → target → address の順
{ url: 'https://api.example.com/foo', target: 'evil.com' }
// → value = 'https://api.example.com/foo' (host 未定義なので url を採用)
```

**意味**: allow-list を書く側は、LLM が生成する input 形状を意識する必要がある。同じ意味でも `host: 'api.example.com'` と `url: 'https://api.example.com/'` で抽出対象が変わる。

### 3-3. `*` 単独パターンのリスク

```yaml
allowed:
  networks: ['*'] # 事実上 allow-all
  filesystemWrites: ['*']
  shellCommands: ['*']
```

`""` (空文字) で `startsWith` が常に true を返すため、`*` のみは **全件許可** と等価。これを書いた SKILL は承認フローを全バイパスする。SKILL.md レビュー時に grep で検出し、原則拒否する運用を推奨。

## 4. 承認ゲートの契約

`ApprovalGate.request(plan, signal): Promise<ApprovalDecision>` の約束事:

| 状態 | 結果 |
|---|---|
| ユーザが承認 | `{ approved: true }` |
| ユーザが拒否 | `{ approved: false, reason?: '...' }` |
| `signal` が abort された | Promise が `AbortError` で reject |
| (option) timeout 到達 | `{ approved: false, reason: 'approval timed out' }` で resolve (reject ではない) |

### 4-1. `tool-loop.ts` 側の取り扱い

`handleToolCall` はゲート結果を次のように扱う:

- **reject** → `tool-call-rejected` event を emit、そのツール呼び出し分だけ `Error` を throw (`runAttempt` が catch して tool 結果を `{ error: '...' }` に置換して継続)
- **abort 例外** → `toolInvoker.cancel(callId)` を呼び、そのまま上位へ伝搬 (`runAttempt` が `stopReason: 'aborted'` に集約)
- **approve** → `tool-call-approved` を emit、`toolInvoker.invoke` を実行

つまり **「拒否」は 1 件の tool error にダウングレードされ、ターン自体は続行** する。ターン全体を止めたいなら UI 側から `cancelTurn(turnId)` を使って abort する。

### 4-2. `createInteractiveApprovalGate` の保証

実装: `packages/agent-runtime/src/approval.ts`。

- **per-request settle**: 同じ `plan.id` は 1 度だけ resolve される (double-resolve safety)
- **listener 分離**: `emit` / `onSettled` コールバックが throw しても他の待機者は影響を受けない (`try/catch` で握り潰す)
- **signal cleanup**: finalize / finalizeAbort の両方で `signal.removeEventListener('abort', ...)` を行う。長時間走るターンでもリスナーがリークしない
- **プリアボート検知**: `signal.aborted` で入ると即 reject、emit すら呼ばれない

### 4-3. 例外パターン

| シナリオ | 挙動 |
|---|---|
| 承認モーダル表示前に `controller.abort()` | `request()` が直接 `AbortError` で reject、`emit` は呼ばれない |
| モーダル表示中に `controller.abort()` | `signal.addEventListener('abort', onAbort, { once: true })` が発火 → `finalizeAbort` → `AbortError` で reject、`onSettled(id, { aborted: true })` を emit |
| `gate.resolve(id, decision)` を 2 回呼ぶ | 2 回目は `pending.get(id)` が `undefined` を返し、no-op |
| `gate.resolve('unknown-id', …)` | no-op |

## 5. store 層でのゲート分離

`packages/stage-ui/src/stores/modules/agent-runtime.ts` は per-turn に gate を生成する:

```ts
const approvalGatesByTurn = new Map<turnId, InteractiveApprovalGate>()
const approvalTurnByRequestId = new Map<requestId, turnId>()
```

この 2 マップがないと:

- ターン A のツールがモーダルを開いている最中に、ターン B が同じ requestId で resolve すると、A のゲートが解かれて B の入力が A の tool に流れる
- ターン完了時に「全ての pending を clear」すると、並走する別ターンの pending まで消える

**したがって**: どの gate をどの turn に紐付けるかは **必ず turnId スコープ** で管理する。将来 auto-approval を足す場合でも、`requiresApproval=false` のフローは gate を bypass するだけなので、この契約は崩れない (auto-approval gate を別に作って `ApprovalGate` interface 経由で差し込む提案は棄却された。理由: sensitivity 判定で十分かつ bypass を gate 内に隠すと audit しにくい)。

## 6. abort と timeout

### 6-1. signal の階層

| signal | 所在 | 役割 |
|---|---|---|
| outer (reset / shutdown) | renderer (`createResetController`) | セッションリセットで全ターンを止める |
| per-turn | renderer (`dispatchTurn` の `AbortController`) | ユーザが 1 ターンだけ止めるボタン |
| ModelDriver 内 | `modelDriver.stream(..., signal)` | HTTP 接続 / SSE の中断 |
| ToolInvoker 内 | `toolInvoker.invoke(..., signal)` | 外部呼び出しの中断 |

これらは `linkAbortSignals([outer, perTurn])` で合流できる。harness 内部では `runAttempt(params, deps)` の `params.signal` 1 本だけを受け取る。

### 6-2. 既定のタイムアウト

現時点で `createInteractiveApprovalGate` の `timeoutMs` は **未指定** (= タイムアウト無し) で使われている。ユーザが承認モーダルを放置した場合、対応するターンは無期限に待つ。運用でタイムアウトが必要になったら:

```ts
createInteractiveApprovalGate({
  emit,
  onSettled,
  timeoutMs: 5 * 60 * 1000, // 5 分
})
```

を指定する。タイムアウトは **soft reject** (`{ approved: false, reason: 'approval timed out' }`) で返るので、harness 側は tool error として扱って turn 継続する。Turn 自体を止めたいなら UI から `cancelTurn(turnId)` を呼ぶ。

### 6-3. `maxToolCalls`

`runAttempt(params, deps)` は `params.maxToolCalls ?? 20` で 1 ターン当たりのツール呼び出しを制限する。超過すると `stopReason: 'max_tool_calls'` で早期終了。LLM が自己参照ループに陥ったときの安全弁で、tool の冪等性 / 外部呼び出しコストを考えて設定する。

## 7. IPC レイヤーのガード

| Eventa | ガード | 備考 |
|---|---|---|
| `agentRuntimeAddCronJob` / `agentRuntimeToggleCronJob` | `manager.isEnabled()` が false なら `Error('agent-runtime-disabled')` | 機能 OFF 時に cron が追加されない |
| `agentRuntimeRemoveCronJob` | enabled チェック付き、disabled なら `{ ok: false }` | UI は no-op として扱う |
| `agentRuntimeListSkills` / `ListCronJobs` / `ReloadSkills` | disabled なら `[]` | 情報取得は副作用無しなので落ちず空返す |
| `agentRuntimeCronTriggered` (event) | renderer 側で `enabled.value && ctx.on(...)` | main が誤発火しても renderer が無視 |

## 8. 監査 (audit) 用のイベント

`onAgentEvent` に流れる `AgentEvent` のうち、セキュリティ監査で参照すべきもの:

| event kind | 含まれる情報 | 用途 |
|---|---|---|
| `plan` | `AgentPlan` (目的 / ステップ) | ターン開始の context |
| `approval-required` | `approvalId`, `plan.toolName`, `plan.input`, `plan.sensitivityReason` | 「なぜ承認が必要になったか」の証跡 |
| `tool-call-approved` / `tool-call-rejected` | `callId`, (reject のみ) `reason` | 誰が許可したか (UI 側の入力) と拒否理由 |
| `tool-call-completed` | `output`, `durationMs` | 出力と所要時間 — 異常に早い / 遅いものを検出 |
| `turn-finished` | `stopReason` | `error` / `max_tool_calls` / `aborted` の割合を集計 |

Devtools の `agent-runs.vue` がこのイベントログを可視化する。本番運用では外部 collector (例: Sentry breadcrumb、自前のログサービス) に繋ぐことを推奨。

## 9. セキュリティレビューのチェックリスト

SKILL.md や agent-runtime 関連 PR を通す際に確認する項目:

- [ ] `allowed.networks` / `filesystemWrites` / `shellCommands` に `*` 単独パターンが無い
- [ ] `allowed.shellCommands` の各エントリがスコープ限定 (`git status` 可 / `git *` は要議論)
- [ ] `allowed.networks` が内部 API 限定 (`https://api.example.com/*`) であって、公開 DNS に抜けていない
- [ ] `allowed.filesystemWrites` が scratch / tmp ディレクトリ限定であって、`~/` 直下まで許していない
- [ ] 新しい感度ルールを追加した場合、`CATEGORY_RULES` に test を書いている (`sensitivity.test.ts`)
- [ ] `ApprovalGate` を差し替えた場合、abort / double-resolve / signal cleanup を保っている
- [ ] cron job の `enabled` 既定値が `false` (明示的に ON にするまで走らない)
- [ ] `maxToolCalls` を減らしている PR であれば、想定される最大 tool 呼び出し数が根拠付きで書かれている

## 10. 今後の拡張候補

- **role-scoped allow-list**: スキル単位ではなくユーザのロール (admin / guest 等) で allow-list を切り替える。現状は SKILL.md ローカルに閉じている
- **dry-run mode**: `toolInvoker.invoke` を実際には呼ばず、「呼んだら何が起きるか」を LLM に自己報告させてからユーザ承認、というモード
- **承認の diff 表示**: 現モーダルは input JSON をそのまま出すだけだが、前回承認との diff を表示できると同じ引数の連続 tool 呼び出しを素早く捌ける
- **外部 audit sink**: `createAgentEventBus` で interpose して、安全なチャンネル (非 renderer) に監査ログを転送する

これらは別 PR で扱う。現時点の runtime は「sensitivity → approval → invoke の 3 段ガード + abort / timeout / maxToolCalls の 3 段 fuse」を最小の signed contract としている。
