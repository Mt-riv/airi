import { realpath } from 'node:fs/promises'

// NOTICE: Claude Code derives its per-project directory
//         (`~/.claude/projects/<slug>`) by replacing every `/`, `_`, and `.`
//         in the realpath of cwd with `-`. Verified experimentally in Phase 0
//         against Claude Code 2.1.96 — see
//         docs/integrations/claude-code-jsonl-schema.md §1 and
//         scripts/poc/claude-code-tail.mjs.
//
//         The transform is lossy (`project-sample`, `project.sample`,
//         `project_sample`, and `project/sample` all collapse to the same
//         slug). Callers must treat the slug strictly as a directory locator
//         and use `sessionId` as the canonical identifier for a conversation.
const SEPARATOR_PATTERN = /[/._]+/g

export function projectSlugForRealpath(realPath: string): string {
  if (realPath.length === 0) {
    throw new Error('projectSlugForRealpath: path is empty')
  }

  if (realPath.includes('\u0000')) {
    throw new Error('projectSlugForRealpath: path contains NUL byte')
  }

  const trimmed = realPath.length > 1 && realPath.endsWith('/')
    ? realPath.slice(0, -1)
    : realPath

  return trimmed.replace(SEPARATOR_PATTERN, '-')
}

export async function projectSlugFor(dir: string): Promise<string> {
  const resolved = await realpath(dir)
  return projectSlugForRealpath(resolved)
}
