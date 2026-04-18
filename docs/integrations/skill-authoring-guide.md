# SKILL.md 執筆ガイド

> **対象読者**: Airi の agent runtime に新しいスキルを追加するエンジニア / 非エンジニア。
> **スコープ**: `~/.airi/skills/<skill-id>/SKILL.md` の書き方、frontmatter スキーマ、trigger の書き方、allow-list の設計、登録後の挙動確認手順。
> **関連**: `docs/integrations/agent-runtime.md` (runtime 全体像) / `docs/integrations/agent-runtime-security.md` (allow-list の意味と承認フロー) / `packages/skill-registry/src` (実装の一次情報)。

---

## 1. 背景 — なぜ SKILL.md か

Airi の agent runtime は「ユーザの発話に応じて、main プロセスが読み込み済みのスキル集から関連するものだけを拾い、agent の system prompt に混ぜる」という構造になっている。Anthropic の Claude Code が採用している SKILL.md 形式と互換を取るため、**YAML frontmatter + Markdown 本文** のシンプルな単一ファイルフォーマットを使う。

これにより:

- **スキルの共有が容易**: 1 ファイルを `~/.airi/skills/` に置くだけで登録完了。
- **レビューしやすい**: Markdown なので GitHub PR diff がそのまま人間可読。
- **ランタイムは decoupled**: `@proj-airi/skill-registry` は純粋にパース + マッチャーで、Airi 以外の CLI からも同じ形式が使える。

## 2. ディレクトリ配置

```
~/.airi/skills/
  search-the-web/
    SKILL.md
    examples/
      hello.md
  translate-ja-en/
    SKILL.md
```

| 規則 | 説明 |
|---|---|
| `SKILL.md` は **ディレクトリ内に必須** | `discoverSkills` は `~/.airi/skills/*/SKILL.md` パターンで探す |
| ディレクトリ名は自由 | マッチングに使われるのは frontmatter の `id` のみ |
| 付属ファイルは自由 | `examples/`, `prompts/` などを同じディレクトリに置いても OK。runtime は読まない |
| 隠しディレクトリ (`.`) | サブディレクトリ名が `.` で始まる場合も `readdir` が拾うため、登録したくないなら別のルートに置く |

main プロセスは `join(homedir(), '.airi', 'skills')` を既定の roots として discovery する (`setupSkillsManager`)。テスト時は `{ userSkillsDir }` オプションを渡すと差し替えられる。

## 3. frontmatter スキーマ

valibot で厳密に validate される (`packages/skill-registry/src/schemas.ts`)。未知フィールドは **許容される** が参照されない。

| フィールド | 型 | 必須 | 意味 |
|---|---|---|---|
| `id` | `string` | ✅ | グローバル一意 ID。discovery は「最初に見つかった ID 勝ち」で重複をスキップする |
| `name` | `string` | ✅ | UI 表示名 |
| `description` | `string` | ✅ | 一言説明。agent の system prompt に混ぜる前のメタ情報用 |
| `triggers` | `string[]` | ✅ | 各要素は **ECMAScript 正規表現ソース**。後述の "matchPrompt" 参照 |
| `tools` | `Array<{ name: string, description?: string }>` | — | 使用したいツールの宣言。**実行はしない**、ドキュメントとしての役割 |
| `allowed` | `AllowList` | — | 感度分類されたツール向けの allow-list。詳細は `agent-runtime-security.md` |

### `AllowList` の内訳

```yaml
allowed:
  networks:
    - https://api.example.com/*
  filesystemWrites:
    - /Users/me/scratch/*
  shellCommands:
    - git status
    - pnpm run *
```

- **trailing `*`**: プレフィックス一致。`https://api.example.com/*` は `https://api.example.com/foo` にも `https://api.example.com/v2/bar` にもマッチ。
- **`*` 無し**: 完全一致。`git status` は `git status -s` にはマッチしないので注意。
- 対応する感度カテゴリ (`network` / `filesystem.write` / `shell`) のツールが呼ばれたときだけ参照される。無関係なツールには影響しない。

## 4. 最小の SKILL.md 例

```markdown
---
id: search-the-web
name: Search the Web
description: Resolve ambiguous references by querying a web search tool.
triggers:
  - "search"
  - "look ?up"
  - "latest news"
tools:
  - name: web.search
    description: Query a search API and return top-5 summaries.
allowed:
  networks:
    - https://api.example.com/*
---

When the user's intent is to retrieve fresh or ambiguous information that
is not obviously in memory, call `web.search` with a focused query and
summarise the top 3 hits in bullet form. Always cite the URL.
```

## 5. trigger の書き方

`compileTriggers(triggers: string[])` は各要素を `new RegExp(pattern, 'i')` で compile する。つまり:

- **case-insensitive**: `Search` も `SEARCH` もマッチ
- **文字列検索ではなく regex**: `.` や `?` はメタ文字。リテラルで `?` を入れたいなら `\\?` とエスケープ
- **anchored ではない**: `search` は `please search the web` 内にもマッチ
- **無効な正規表現はエラー**: `loadSkillFromDirectory` が例外を throw、`discoverSkills` がそのスキルを skip して console.warn

### `matchPrompt` の動き

`matchPrompt(prompt, skill)` は distinct trigger regex が何個マッチしたかを `score` として返す。`registry.resolve(prompt)` は:

1. `score > 0` のスキルを絞り込み
2. **`score` 降順** (マッチ数が多い順)
3. 同点は **登録順 (register 呼び出し順)**

でソートする。スキル `A` が `triggers: ["search", "query"]`、スキル `B` が `triggers: ["search"]` の場合、プロンプト `"search for latest queries"` は A (score=2) → B (score=1) の順に並ぶ。

### 落とし穴

- 過剰にマッチする trigger は他スキルを押しのけるので、過度に汎用なトリガーは避ける (`"a"` や `"."` のような単一文字 / メタ文字のみは事故のもと)。
- 日本語でマッチさせたい場合、スペース無しの言語特性上 `"検索"` のような短い語はプロンプト内で誤マッチしやすい。文脈語を足す (例: `"を?検索"`) ことを推奨。
- 同義語は別エントリで列挙する。OR ブランチ `"search|find"` でも書けるが、`score` の計算は distinct regex 単位なので表現力を活かすなら個別エントリの方が意図を反映しやすい。

## 6. body (Markdown 本文) の扱い

frontmatter より後の本文は:

- `parsed.content.trim()` として `SkillDefinition.body` に格納される
- discovery / registry には「本文 = agent へのガイドライン」という semantic が暗黙的に期待されている (runtime は本文を素通しで system prompt に混ぜるロジックが外側にある)
- 本文に画像や複雑な表を入れても OK。ただし **runtime がそのまま LLM に送る** 想定なので、冗長な内容はコストに直結する

実務的な推奨:

- **箇条書き + 1 段落** を基本。複数シナリオを並べるときは H2/H3 でセクション分けする
- tool call のための「when to use」「do not use」を明記する (例: `"Never call web.search for trivia already present in conversation history."`)
- ユーザ言語 (日本語 / 英語) に合わせて書き分ける。LLM に通した結果の品質が変わる

## 7. 登録 → 反映までの手順

1. `~/.airi/skills/<your-skill-id>/SKILL.md` を作る
2. Airi (stage-tamagotchi) を起動、または `Settings → Modules → Agent Runtime` で enable
3. 同画面の **Reload Skills** ボタンを押して discovery を再実行
4. `Devtools → Agent Runs` を開いて次のターンで system prompt 内にスキル本文が混ざっているか確認

手順 3 は IPC `agentRuntimeReloadSkills` を叩き、main 側の `setupSkillsManager.reload()` → `registry.clear()` → `registry.register(...)` を回す。既存ターンには影響しない。

## 8. skill ID 命名規則

- **kebab-case** (ASCII 英数 + `-` のみ) を推奨。OS 間で安全に扱える
- 名前空間プレフィクスを入れると競合しにくい (例: `acme.search-the-web`)。ただし `.` を入れても登録自体は可
- 変更時は **ID を変えない**。discovery は ID 単位で重複排除 / 参照するため、ID 変更は実質別スキル

## 9. testing — ローカルで正しく動くか確認する

### 9-1. 単体テスト

`@proj-airi/skill-registry` は pure Node なので Vitest で直接 test できる:

```ts
import { loadSkillFromDirectory, matchPrompt } from '@proj-airi/skill-registry'
import { describe, expect, it } from 'vitest'

describe('my skill', () => {
  it('matches expected prompts', async () => {
    const skill = await loadSkillFromDirectory('./test/fixtures/search-the-web')
    expect(matchPrompt('please search the web', skill).matched).toBe(true)
    expect(matchPrompt('tell me a joke', skill).matched).toBe(false)
  })
})
```

### 9-2. discovery ラウンドトリップ

一時ディレクトリを使って discovery まで通すテスト:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSkillRegistry, discoverSkills } from '@proj-airi/skill-registry'

const root = await mkdtemp(join(tmpdir(), 'airi-skills-'))
const dir = join(root, 'search-the-web')
await mkdir(dir)
await writeFile(join(dir, 'SKILL.md'), YAML_AND_BODY)

const skills = await discoverSkills([root])
const registry = createSkillRegistry()
skills.forEach(s => registry.register(s))

expect(registry.resolve('search for cats')[0]?.id).toBe('search-the-web')
```

### 9-3. 統合テスト

`AIRI_TEST_AGENT_RUNTIME=1` で gate されているテストスイート (`apps/stage-tamagotchi/test/integration/agent-runtime.test.ts`) がリアル MCP ツール + cron までラウンドトリップで検証する。CI でも default skip。

## 10. 運用上の注意

| テーマ | 指針 |
|---|---|
| シークレットの記述 | 本文に API キーや個人情報を書かない。LLM に送られる前提で扱う |
| LLM-unfriendly な指示 | 「絶対に〜してはいけない」系の否定指示は守らせにくい。肯定形で書く |
| 複数スキルの重複 | 同じ目的を複数スキルに分散させない。score 計算が曖昧になり、挙動がぶれる |
| allow-list の緩め過ぎ | `networks: ["*"]` のような wildcard-only は事実上 allow-all と等価。承認フローをバイパスするので避ける |
| discovery の副作用 | loader は **フル読込** を毎回やる。数百スキルを載せると起動時間に効く。必要ならサブディレクトリを分割 |

## 11. トラブルシュート早見表

| 症状 | 原因候補 | 確認 |
|---|---|---|
| スキルが `listSkills()` に出てこない | frontmatter 不整合、または ID 重複 | main の stdout に `[skill-registry] Skipping "<dir>": …` が出ているか |
| trigger が何にもマッチしない | 正規表現のエスケープ漏れ、もしくは `triggers` が空配列 | `matchPrompt('<実際のプロンプト>', skill)` をローカルで試す |
| body が system prompt に入らない | runtime 側の wiring バグ (skill-registry の責務外) | `turnRecords[turnId].events` の plan / request を確認 |
| Reload Skills を押しても変わらない | `agentRuntime.enabled` が false | Settings でまず enable、その後 Reload |
| 「Skill with id "..." is already registered」 | `register` が同 ID で 2 回呼ばれた | discovery は同 ID を skip するが、手動で register している場合は clear → register の順を守る |

## 12. さらに踏み込みたいときの参照

| 目的 | 参照先 |
|---|---|
| パース挙動を理解したい | `packages/skill-registry/src/load-skill.ts` |
| 正規表現のコンパイル / キャッシュ | `packages/skill-registry/src/matcher.ts` |
| registry の優先度計算 | `packages/skill-registry/src/registry.ts` |
| main 側の wiring | `apps/stage-tamagotchi/src/main/services/airi/skills/index.ts` |
| renderer の UI | `packages/stage-pages/src/pages/settings/modules/agent-runtime.vue` |
