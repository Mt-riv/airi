import type { NormalizedClaudeCodeEvent } from './types'

import process from 'node:process'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createClaudeCodeManager } from './index'

// Gate: integration tests hit the real `claude` CLI and reach an Anthropic
// endpoint, so they are opt-in. Set `AIRI_TEST_CLAUDE_CODE=1` to run them.
//
//   AIRI_TEST_CLAUDE_CODE=1 pnpm -F @proj-airi/stage-tamagotchi exec \
//     vitest run src/main/services/airi/claude-code/integration.test.ts
//
// The test spawns `claude -p "..."` with stream-json output, captures the
// normalised events emitted by the manager, and asserts the dialect we
// documented in Phase 0 still holds against the installed CLI.
const INTEGRATION_ENABLED = process.env.AIRI_TEST_CLAUDE_CODE === '1'
const describeIntegration = INTEGRATION_ENABLED ? describe : describe.skip

describeIntegration('ClaudeCodeManager (integration — real claude binary)', () => {
  let projectDir: string
  let claudeProjectsRoot: string

  beforeEach(async () => {
    // Use a throwaway cwd so the test never touches the user's real
    // `~/.claude/projects/<repo>` directory. The manager still resolves
    // `~/.claude/projects` by default for writes, so we also redirect
    // `claudeProjectsRoot` to a tmp dir just for `listSessions` calls.
    projectDir = await mkdtemp(join(tmpdir(), 'airi-cc-it-'))
    claudeProjectsRoot = await mkdtemp(join(tmpdir(), 'airi-cc-it-projects-'))
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
    await rm(claudeProjectsRoot, { recursive: true, force: true })
  })

  it('streams normalised events for a simple "2+2" prompt and resolves the session id', async () => {
    const manager = createClaudeCodeManager({
      binaryPath: process.env.AIRI_TEST_CLAUDE_BINARY ?? 'claude',
      claudeProjectsRoot,
    })

    const received: Array<{ sessionId: string, event: NormalizedClaudeCodeEvent }> = []
    manager.onEvent((sessionId, event) => received.push({ sessionId, event }))

    const result = await manager.sendPrompt({
      projectDir,
      sessionId: null,
      text: 'Reply with just the number: 2+2',
    })

    try {
      // Result assertions: the runner must resolve with a session id we can
      // reuse on follow-up turns.
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.sessionId).toBeTruthy()
        expect(typeof result.sessionId).toBe('string')
      }

      // Stream assertions: at minimum we should see one assistant-text
      // event carrying the model's reply, followed by a finish event.
      const kinds = received.map(e => e.event.kind)
      expect(kinds).toContain('assistant-text')
      expect(kinds).toContain('finish')

      const text = received
        .filter(e => e.event.kind === 'assistant-text')
        .map(e => (e.event as { text: string }).text)
        .join('')
      expect(text.length).toBeGreaterThan(0)

      // Every received event must carry the same resolved session id —
      // otherwise the manager's session id buffering is broken.
      const resolvedIds = new Set(received.map(e => e.sessionId))
      expect(resolvedIds.size).toBe(1)
    }
    finally {
      await manager.stopAll()
    }
  }, 120_000)

  it('checkBinary succeeds against the installed claude CLI', async () => {
    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot,
    })

    const result = await manager.checkBinary({
      binaryPath: process.env.AIRI_TEST_CLAUDE_BINARY ?? 'claude',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.version.length).toBeGreaterThan(0)
      // Claude Code prints e.g. "2.1.96 (Claude Code)" — loose match so
      // the test survives minor version bumps.
      expect(result.version).toMatch(/\d+\.\d+\.\d+/)
    }
  }, 15_000)

  it('resolveSlug maps the tmp project dir to a canonical slug', async () => {
    const manager = createClaudeCodeManager({
      binaryPath: 'claude',
      claudeProjectsRoot,
    })

    const result = await manager.resolveSlug({ projectDir })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.slug).toMatch(/^-/)
      expect(result.slug).not.toContain('/')
      expect(result.slug).not.toContain('_')
      expect(result.slug).not.toContain('.')
      expect(result.realPath).toBeTruthy()
    }
  })
})
