# @proj-airi/skill-registry

SKILL.md loader and skill registry for AIRI. Discovers, parses, validates, and resolves OpenClaw-style skill definitions from workspace directories.

## What it does

- **`loadSkillFromDirectory`** — reads a `SKILL.md` file from a directory, parses YAML frontmatter via `gray-matter`, validates with Valibot, and returns a `SkillDefinition`.
- **`createSkillRegistry`** — in-memory registry with `register`, `resolve`, `list`, and `clear`. Resolves a prompt string to matching skills sorted by score (number of distinct trigger hits) descending.
- **`discoverSkills`** — walks an array of root directories, finds sub-directories containing `SKILL.md`, loads each one, and deduplicates by `id` (first registration wins).
- **`matchPrompt`** — pure function: compiles trigger regex patterns from a skill and returns `{ matched, score }` for a given prompt string.

## How to use

```ts
import { createSkillRegistry, discoverSkills } from '@proj-airi/skill-registry'

const skills = await discoverSkills([
  `${process.env.HOME}/.airi/skills`,
])

const registry = createSkillRegistry()
for (const skill of skills) {
  registry.register(skill)
}

const matches = registry.resolve('search for the latest news')
// → SkillDefinition[] sorted by trigger match score DESC
```

## When to use

- In the Electron main-process agent service to load the user's `~/.airi/skills/` workspace and built-in skill directories at startup.
- In the agent harness to select which skill instructions to inject into the system prompt before a turn.
- In unit tests that need to exercise skill loading and resolution with minimal fixtures.

## When NOT to use

- Do not import this package from Vue components directly — use a Pinia store/composable that wraps it.
- Do not use this for runtime tool invocation — `SkillDefinition.tools` is a declaration list only; execution goes through `@proj-airi/agent-runtime`'s `ToolInvoker`.
- Do not rely on filesystem watching — this package performs one-shot discovery. Build a watcher layer on top if live-reload is needed.
