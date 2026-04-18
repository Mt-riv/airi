# Agent Runtime — アーキテクチャと統合ガイド

> **対象読者**: Airi の agent runtime (自律エージェント機能) に触れる PR をレビューする人、renderer / main 側の service 配線を変更する人、新しい `ModelDriver` / `ToolInvoker` / `ApprovalGate` 実装を足す人。
> **スコープ**: `packages/agent-runtime` の公開 API、Electron main / renderer の責務分担 (Option A)、ターン実行のライフサイクル、既存の Pinia store / composables / UI への接続点。
> **関連**: `docs/integrations/skill-authoring-guide.md` (SKILL.md の書き方) / `docs/integrations/agent-runtime-security.md` (感度判定・承認・allow-list)。

---

## 1. 設計ゴールと非ゴール

- **Goal-1**: ターン実行ループ (model stream + tool call + approval gate) を Electron / Vue / 個別 provider から切り離したプレーンな TypeScript ライブラリに閉じ込め、`Vitest` で単体テスト可能な状態に保つ。
- **Goal-2**: Cron スケジューラ + skill registry を main プロセスで動かし、ターン実行だけを renderer に寄せる (Option A)。これにより renderer 側のモデル/ツール設定を再利用しつつ、persistence を main で一元化できる。
- **Non-goal**: 特定の LLM プロバイダ (xsai / OpenAI / Anthropic) に依存する streaming ロジックを `agent-runtime` に入れない。駆動は `ModelDriver` 実装で行う。
- **Non-goal**: UI イベントの直接ディスパッチ。`AgentEvent` は `onAgentEvent` コールバック経由で受け取り、renderer 側で Pinia / Eventa に橋渡しする。

## 2. パッケージ境界

| パッケージ | 役割 | 代表 export |
|---|---|---|
| `@proj-airi/agent-runtime` | ターン / ツール呼び出し / 承認ゲート / event bus | `createAgentHarness`, `runAttempt`, `handleToolCall`, `evaluateSensitivity`, `createInteractiveApprovalGate` |
| `@proj-airi/skill-registry` | `SKILL.md` 解析と registry | `loadSkillFromDirectory`, `discoverSkills`, `createSkillRegistry`, `matchPrompt` |
| `@proj-airi/cron-runtime` | 単一タイマー reschedule ベースの cron スケジューラ | `createCronScheduler`, `createJsonJobStore`, `SystemClock`, `createFakeClock` |
| `apps/stage-tamagotchi/src/main/services/airi/agent` | main プロセス側 orchestration、IPC ハンドラ、cron broadcast | `setupAgentManager`, `createAgentService` |
| `apps/stage-tamagotchi/src/main/services/airi/skills` | main プロセス skills マネージャー | `setupSkillsManager` |
| `apps/stage-tamagotchi/src/main/services/airi/cron` | main プロセス cron マネージャー + trigger bridge | `setupCronManager`, `createCronTriggerBridge` |
| `packages/stage-ui/src/stores/modules/agent-runtime.ts` | renderer 側 Pinia store、harness 駆動、承認キュー管理 | `useAgentRuntimeStore` |
| `apps/stage-tamagotchi/src/renderer/composables/agent-approval.ts` | 承認モーダル用のビューモデル | `useAgentApproval` |
| `apps/stage-tamagotchi/src/renderer/components/agent/approval-modal.vue` | 承認モーダル UI | `<AgentApprovalModal />` |

## 3. Option A: main / renderer の責務分担

| レイヤー | コンポーネント | 所在 |
|---|---|---|
| 永続化 | `~/.airi/cron/jobs.json`、`~/.airi/skills/` ディレクトリ | main |
| Skill discovery | `setupSkillsManager` → `@proj-airi/skill-registry` | main |
| Cron scheduling | `setupCronManager` → `@proj-airi/cron-runtime` | main |
| Cron trigger broadcast | `agentRuntimeCronTriggered` (Eventa event) | main → renderer |
| ターン実行 (model stream + tool call) | `createAgentHarness` + `runAttempt` | renderer |
| 承認 UI | `<AgentApprovalModal />` + `useAgentApproval` | renderer |
| Provider / model resolve | `useProvidersStore` + `useConsciousnessStore` | renderer |
| MCP ツール実行 | `getMcpToolBridge()` | renderer |

main 側に persistence と scheduling を集約し、renderer 側では **既存のチャット設定 (`consciousnessStore.activeProvider` / `.activeModel`) をそのまま再利用** する設計になっている。これにより「チャットで使っているモデル」と「cron から起動されたモデル」が一致する。

## 4. ターン実行のライフサイクル

以下は cron job 経由で 1 ターンが走るときのシーケンスを表にしたもの。ユーザ発話経由の `dispatchTurn` 直接呼び出しも同じフローに合流する。

| 手順 | 実行箇所 | 内容 |
|---|---|---|
| 1. job fire | main (`cron-runtime` scheduler) | `onTrigger` コールバックが `CronTriggerEvent` と共に呼ばれる |
| 2. bridge | main (`createCronTriggerBridge`) | `turnId = crypto.randomUUID()` を採番し `{ jobId, turnId, prompt, skillId }` を broadcaster に渡す |
| 3. emit | main (`AgentService`) | 登録済み `CronBroadcaster` 経由で `agentRuntimeCronTriggered` を eventa に emit |
| 4. receive | renderer (`useAgentRuntimeStore.subscribeCronTriggers`) | `enabled.value` が true のときだけ `dispatchTurn` を呼ぶ |
| 5. resolve provider | renderer | `consciousnessStore.activeProvider/.activeModel` から `ChatProvider` を得る |
| 6. wire harness | renderer | `createXsaiModelDriver` + `createMcpToolInvoker` + `createInteractiveApprovalGate` を `createAgentHarness` に渡す |
| 7. runAttempt | `runAttempt` | `modelDriver.stream(...)` を async iterate し、`text-delta` / `thinking-delta` / `tool-call-requested` / `finish` を捌く |
| 8. tool call | `handleToolCall` | `evaluateSensitivity` → (requiresApproval なら) `approvalGate.request` → `toolInvoker.invoke` → `tool-call-completed` emit |
| 9. events | renderer | `onAgentEvent` コールバックが `turnRecords[turnId].events` に push、devtools の `agent-runs` ページで可視化 |
| 10. finalize | renderer (`finally` block) | `approvalGatesByTurn.delete(turnId)`、残留 `pendingApprovals` を掃除、`activeTurns` 更新 |

## 5. Harness 構築例

以下は renderer 側で使っている実配線の最小抜粋 (`packages/stage-ui/src/stores/modules/agent-runtime.ts` の `dispatchTurn` を簡約したもの)。

```ts
import {
  createAgentHarness,
  createInteractiveApprovalGate,
} from '@proj-airi/agent-runtime'

const approvalGate = createInteractiveApprovalGate({
  emit: (request) => {
    approvalTurnByRequestId.set(request.id, turnId)
    pendingApprovals.value.push({
      id: request.id,
      turnId,
      plan: request.plan,
      createdAt: Date.now(),
    })
  },
  onSettled: (id) => {
    approvalTurnByRequestId.delete(id)
    const idx = pendingApprovals.value.findIndex(p => p.id === id)
    if (idx >= 0)
      pendingApprovals.value.splice(idx, 1)
  },
})

approvalGatesByTurn.set(turnId, approvalGate)

const harness = createAgentHarness({
  modelDriver: createXsaiModelDriver({ model, chatProvider, systemPrompt }),
  toolInvoker: createMcpToolInvoker(),
  approvalGate,
})

const result = await harness.runAttempt({
  turn: { messages, tools, systemPrompt },
  onPartialReply: chunk => recordPartial(turnId, chunk),
  onAgentEvent: event => recordEvent(turnId, event),
  signal: controller.signal,
  maxToolCalls,
})
```

## 6. `ModelDriver` の実装要件

`ModelDriver` は単一メソッド `stream(messages, tools, signal): AsyncIterable<DriverEvent>` だけを持つ。各イベントの意味:

| `DriverEvent.kind` | 意味 | harness 側の扱い |
|---|---|---|
| `text-delta` | 可視テキストの差分 | `onPartialReply({ kind: 'text-delta' })` へ透過 |
| `thinking-delta` | 推論テキストの差分 (非表示想定) | `onPartialReply({ kind: 'thinking-delta' })` へ透過 |
| `tool-call-requested` | ツール呼び出し要求 | `handleToolCall` に delegate、完了後にループ継続 |
| `finish` | ターン終了 | `stopReason` を返して `runAttempt` 終了 |
| `error` | 致命的エラー | `stopReason: 'error'` で打ち切り |

`signal.aborted` を毎 await 前に確認し、中断時は `throw createAbortError('…')` を投げる (実装は `packages/agent-runtime/src/abort.ts` 参照)。

## 7. `ToolInvoker` の実装要件

```ts
export interface ToolInvoker {
  invoke: (callId: string, toolName: string, input: unknown, signal: AbortSignal) => Promise<unknown>
  cancel: (callId: string) => void
}
```

- `invoke` は AbortSignal を尊重し、aborted なら `AbortError` を throw。
- 戻り値は serialisable な JSON 値を期待 (`string` / plain object / array / null)。MCP bridge のように `structuredContent` → `toolResult` → `content` のフォールバックを持つ実装もある。
- `cancel` は best-effort。呼び出し中のネットワークソケットなど真に中断できない場合でも、`signal` のイベントリスナー解除などクリーンアップの機会として使う。

## 8. 承認ゲートの設計

`createInteractiveApprovalGate` は「emit して resolve を待つ」モデル:

1. harness 側で `gate.request(plan, signal)` が呼ばれる
2. gate が `ApprovalRequest` を `emit()` コールバックへ渡す (renderer は `pendingApprovals` に push)
3. UI で承認 / 拒否されると store の `resolveApproval(id, decision)` が `gate.resolve(id, decision)` を呼ぶ
4. gate の `Promise` が `decision` で resolve、harness 側は tool 呼び出しを継続 or skip する

**per-turn 分離**: 1 つの renderer で複数ターンが並走しうるため、store は `approvalGatesByTurn: Map<turnId, gate>` と `approvalTurnByRequestId: Map<requestId, turnId>` で routing する。ゲートをシングルトンにすると、別ターンの `resolve(id, …)` が誤って現ターンの待機を解除する race が起きる。

**タイムアウト / abort**: `timeoutMs` 指定時は指定時間で自動的に `{ approved: false, reason: 'approval timed out' }` が返る。`signal.aborted` は `createAbortError` で reject され、harness 側で `StopReason: 'aborted'` に集約される。

## 9. IPC (Eventa) 契約

main 側で `defineInvokeHandlers` により以下が登録される。renderer 側の `safeInvoke` ヘルパーは ipcRenderer が無い環境 (Storybook / 単体テスト) では `null` を返すように設計されている。

| Eventa ID | 方向 | 用途 |
|---|---|---|
| `agent-runtime:status` | invoke | runtime 状態 (enabled / skillsLoaded / cronJobsEnabled) |
| `agent-runtime:set-enabled` | invoke | ON/OFF 切り替え (main で cron start/stop) |
| `agent-runtime:list-skills` / `reload-skills` | invoke | skill discovery 再実行 |
| `agent-runtime:list-cron-jobs` / `add-cron-job` / `remove-cron-job` / `toggle-cron-job` | invoke | cron CRUD |
| `agent-runtime:cron-triggered` | event (main → renderer) | cron が fire したことを通知 |

契約の実体は `apps/stage-tamagotchi/src/shared/eventa.ts` に集約されている。新しい操作を足すときはここと `electron-service.ts` 両方を更新する。

## 10. Renderer store から見えるデータ形状

| ref / reactive | 型 | 備考 |
|---|---|---|
| `enabled` | `Ref<boolean>` | ユーザ設定の feature flag |
| `skills` | `Ref<AgentRuntimeSkillDefinition[]>` | reload 時に再充填 |
| `cronJobs` | `Ref<AgentRuntimeCronJob[]>` | CRUD 後に再取得 |
| `activeTurns` | `Ref<number>` | `runningControllers.size` と同期 |
| `turnRecords` | `reactive<Record<turnId, AgentTurnRecord>>` | text + events + error ログ |
| `recentTurns` | `Ref<turnId[]>` (先頭 50 件) | devtools ページの列挙用 |
| `pendingApprovals` | `Ref<PendingApprovalRecord[]>` | モーダル表示対象 (先頭のみ表示) |

## 11. Devtools

`apps/stage-tamagotchi/src/renderer/pages/devtools/agent-runs.vue` が `turnRecords` と `recentTurns` を可視化する。主な用途:

- どのターンがどの cron job に紐付いているか確認
- text delta ログと `AgentEvent` の時系列を突き合わせて driver のバグを追う
- `stopReason` と `error` メッセージからタイムアウト / abort / max tool call 超過の内訳を確認

## 12. テスト方針

| レイヤー | 推奨ツール | 代表ファイル |
|---|---|---|
| Pure logic (sensitivity / matcher / abort / approval) | Vitest + `vi.useFakeTimers` | `packages/agent-runtime/src/*.test.ts`, `packages/skill-registry/src/*.test.ts`, `packages/cron-runtime/src/*.test.ts` |
| Harness integration | Vitest + mock driver / invoker / gate | `packages/agent-runtime/src/run-attempt.test.ts` |
| Renderer composable | Vitest + `vi.mock` で Pinia store を差し替え | `apps/stage-tamagotchi/src/renderer/composables/agent-approval.test.ts` |
| E2E (gated) | Vitest + `AIRI_TEST_AGENT_RUNTIME=1` | `apps/stage-tamagotchi/test/integration/agent-runtime.test.ts` |

**原則**:

- `vi.mock('@proj-airi/agent-runtime', …)` での差し替えは避け、実モジュールの exported factory をそのまま使う (型安全性のため)。
- Electron / IPC に依存する部分は `safeInvoke` が `null` を返す経路を意識し、IPC レスポンスの型を直接 `vi.fn<…>()` でスタブする。
- 実プロバイダに叩きに行く integration test は環境変数 gate (`AIRI_TEST_AGENT_RUNTIME=1`) でデフォルト skip にする。

## 13. 既知の落とし穴

- **cron job のクロックは分単位**: `cron-parser` が minute-resolution なので、`*/5 * * * * *` のような秒精度 cron はサポートしていない。必要なら別の scheduler を足す。
- **MCP ツール取り消しの粗さ**: 現在の `createMcpToolInvoker().cancel` は no-op。進行中の MCP 呼び出しは `signal.aborted` を invoke 内でチェックしない限り走り切る。ユーザ可視の stop ボタンを UI に載せる場合は MCP bridge 側の対応が前提。
- **ターン中に enabled を OFF にした場合**: `cancelAllTurns()` で既存コントローラーを abort するが、harness 側の `runAttempt` が `AbortError` を throw して終わるまでには 1 チャンク分のズレが出る。
- **activeTurns の source of truth**: Option A で renderer に一本化済み。`agentRuntimeStatus` は表示用の skill/cron 数だけに使い、`activeTurns` フィールドは UI で **使わない** こと。

## 14. 追加要件が来たときの拡張ポイント

- **新しい感度ルール**: `packages/agent-runtime/src/sensitivity.ts` の `CATEGORY_RULES` に追加。allow-list の対応フィールド名 (`inputFields`) もセットで足す。
- **tool の動的発見**: renderer 側で `dispatchTurn` の `extraTools` に渡す。MCP サーバが増えた場合は `getMcpToolBridge()` のブリッジ実装を拡張。
- **telemetry**: `onAgentEvent` に hook して collector を追加するか、`createAgentEventBus` を interpose する。
- **承認 UI の非モーダル化**: `useAgentApproval` を使う新しい view を `packages/stage-ui/src/components/` 側に実装し、`approval-modal.vue` の代わりに差し込む。store 側は変更不要。
