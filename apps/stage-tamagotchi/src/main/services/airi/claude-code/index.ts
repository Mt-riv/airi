import type { BinaryProber } from './binary-prober'
import type {
  EventListener as RunnerEventListener,
  SendPromptInput,
  SendPromptResult,
  SessionRunner,
  SessionRunnerOptions,
} from './session-runner'
import type { SessionWatcher } from './session-watcher'
import type {
  ClaudeCodeCheckBinaryInput,
  ClaudeCodeCheckBinaryResult,
  ClaudeCodeResolveSlugInput,
  ClaudeCodeResolveSlugResult,
  ClaudeCodeSession,
  ClaudeCodeSessionMeta,
  NormalizedClaudeCodeEvent,
} from './types'

import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { createDefaultBinaryProber } from './binary-prober'
import { projectSlugFor, projectSlugForRealpath } from './project-slug'
import { createSessionRunner } from './session-runner'
import { createSessionWatcher } from './session-watcher'

const JSONL_EXTENSION_PATTERN = /\.jsonl$/

export interface ClaudeCodeManagerOptions {
  /** Absolute path to the `claude` binary. */
  binaryPath: string
  /**
   * Root directory Claude Code uses for per-project transcripts. Defaults to
   * `~/.claude/projects`. Overridable for tests.
   */
  claudeProjectsRoot: string
  /**
   * Factory hook so tests can substitute a fake runner (no real child
   * process). Defaults to the production `createSessionRunner`.
   */
  runnerFactory?: (options: SessionRunnerOptions) => SessionRunner
  /**
   * Probes the configured `claude` binary for the settings validator.
   * Defaults to `createDefaultBinaryProber()` which spawns
   * `<binaryPath> --version` via `child_process.spawn`. Tests inject a fake
   * probe to avoid touching the real filesystem.
   */
  binaryProber?: BinaryProber
}

export interface ListSessionsInput {
  projectDir: string
}

export interface AttachSessionInput {
  sessionId: string
  projectDir: string
}

export interface DetachSessionInput {
  sessionId: string
}

export interface SendManagerPromptInput {
  projectDir: string
  sessionId: string | null
  text: string
}

export type ManagerEventListener = (sessionId: string, event: NormalizedClaudeCodeEvent) => void

export interface ClaudeCodeManager {
  listSessions: (input: ListSessionsInput) => Promise<ClaudeCodeSession[]>
  attachSession: (input: AttachSessionInput) => Promise<ClaudeCodeSessionMeta>
  detachSession: (input: DetachSessionInput) => Promise<void>
  sendPrompt: (input: SendManagerPromptInput) => Promise<SendPromptResult>
  checkBinary: (input: ClaudeCodeCheckBinaryInput) => Promise<ClaudeCodeCheckBinaryResult>
  resolveSlug: (input: ClaudeCodeResolveSlugInput) => Promise<ClaudeCodeResolveSlugResult>
  onEvent: (listener: ManagerEventListener) => () => void
  stopAll: () => Promise<void>
}

interface AttachedSession {
  meta: ClaudeCodeSessionMeta
  watcher: SessionWatcher
}

/**
 * Orchestrates Claude Code session discovery, mirroring (via SessionWatcher)
 * and sending (via SessionRunner). The manager is pure domain logic — it
 * knows nothing about Electron or Eventa so it can be unit tested without
 * mocking the main process. Phase 2 will wrap it in a thin Eventa IPC layer.
 */
export function createClaudeCodeManager(options: ClaudeCodeManagerOptions): ClaudeCodeManager {
  const { binaryPath, claudeProjectsRoot } = options
  const runnerFactory = options.runnerFactory ?? createSessionRunner
  const binaryProber = options.binaryProber ?? createDefaultBinaryProber()

  const listeners = new Set<ManagerEventListener>()
  const attached = new Map<string, AttachedSession>()
  const runners = new Map<string, SessionRunner>()

  const emit = (sessionId: string, event: NormalizedClaudeCodeEvent) => {
    for (const listener of listeners) {
      try {
        listener(sessionId, event)
      }
      catch {
        // NOTICE: Swallow listener errors so one bad subscriber cannot break
        //         the pipeline. Upstream error handling (via SessionWatcher
        //         onError) surfaces actual I/O problems.
      }
    }
  }

  const slugDirFor = async (projectDir: string) => {
    const slug = await projectSlugFor(projectDir)
    return { slug, slugDir: join(claudeProjectsRoot, slug) }
  }

  const listSessions = async ({ projectDir }: ListSessionsInput): Promise<ClaudeCodeSession[]> => {
    const { slug, slugDir } = await slugDirFor(projectDir)

    let entries: string[]
    try {
      entries = await readdir(slugDir)
    }
    catch {
      return []
    }

    const jsonlFiles = entries.filter(name => name.endsWith('.jsonl'))
    const sessions = await Promise.all(jsonlFiles.map(async (name) => {
      const filePath = join(slugDir, name)
      const sessionId = name.replace(JSONL_EXTENSION_PATTERN, '')
      const st = await stat(filePath).catch(() => null)
      const meta: ClaudeCodeSessionMeta = {
        sessionId,
        slug,
        filePath,
        cwd: projectDir,
        lastEventAt: st?.mtime.toISOString(),
        eventCount: 0,
      }
      return { meta, running: attached.has(sessionId) } satisfies ClaudeCodeSession
    }))

    // Newest first so UI selectors land on the active session by default.
    // Tie-break by sessionId for deterministic ordering when two files share
    // a modification timestamp (common in tests that create files in quick
    // succession).
    sessions.sort((a, b) => {
      const left = a.meta.lastEventAt ?? ''
      const right = b.meta.lastEventAt ?? ''
      const byMtime = right.localeCompare(left)
      if (byMtime !== 0)
        return byMtime
      return a.meta.sessionId.localeCompare(b.meta.sessionId)
    })

    return sessions
  }

  const attachSession = async ({ sessionId, projectDir }: AttachSessionInput): Promise<ClaudeCodeSessionMeta> => {
    const existing = attached.get(sessionId)
    if (existing)
      return existing.meta

    const { slug, slugDir } = await slugDirFor(projectDir)
    const filePath = join(slugDir, `${sessionId}.jsonl`)

    const meta: ClaudeCodeSessionMeta = {
      sessionId,
      slug,
      filePath,
      cwd: projectDir,
      eventCount: 0,
    }

    const watcher = createSessionWatcher({
      filePath,
      onEvent: (event) => {
        meta.eventCount += 1
        emit(sessionId, event)
      },
    })

    attached.set(sessionId, { meta, watcher })
    await watcher.start()
    return meta
  }

  const detachSession = async ({ sessionId }: DetachSessionInput): Promise<void> => {
    const entry = attached.get(sessionId)
    if (!entry)
      return
    attached.delete(sessionId)
    await entry.watcher.stop()
  }

  const sendPrompt = async (input: SendManagerPromptInput): Promise<SendPromptResult> => {
    const { projectDir, sessionId, text } = input

    const runnerKey = sessionId ?? '__new__'
    let runner = runners.get(runnerKey)
    if (!runner) {
      runner = runnerFactory({
        binaryPath,
        projectDir,
      })
      runners.set(runnerKey, runner)
    }

    // Buffer events until the real session id is known. For brand-new
    // sessions the id only arrives after the runner's first `system.init`
    // line (or in the resolved SendPromptResult). Once known, we flush the
    // buffer and forward every subsequent event live.
    const buffered: NormalizedClaudeCodeEvent[] = []
    let resolvedSessionId: string | null = sessionId

    const flushWithId = (id: string) => {
      for (const event of buffered)
        emit(id, event)
      buffered.length = 0
    }

    const unsubscribeRunner: (() => void) = runner.onEvent(((event) => {
      if (resolvedSessionId != null) {
        emit(resolvedSessionId, event)
        return
      }

      // Peek into meta events for the init session id so streaming stays
      // live even before sendPrompt resolves.
      if (event.kind === 'meta') {
        const raw = event.raw as { type?: unknown, subtype?: unknown, session_id?: unknown } | undefined
        if (raw && raw.type === 'system' && raw.subtype === 'init' && typeof raw.session_id === 'string') {
          resolvedSessionId = raw.session_id
          buffered.push(event)
          flushWithId(raw.session_id)
          return
        }
      }

      buffered.push(event)
    }) as RunnerEventListener)

    try {
      const promptInput: SendPromptInput = { text, sessionId }
      const result = await runner.sendPrompt(promptInput)

      if (result.ok && result.sessionId != null) {
        if (resolvedSessionId == null) {
          resolvedSessionId = result.sessionId
          flushWithId(result.sessionId)
        }

        // Migrate the runner entry from the placeholder key to the real
        // session id so future resumes reuse it.
        if (runnerKey === '__new__') {
          runners.delete(runnerKey)
          runners.set(result.sessionId, runner)
        }
      }

      return result
    }
    finally {
      unsubscribeRunner()
    }
  }

  const checkBinary = async (
    input: ClaudeCodeCheckBinaryInput,
  ): Promise<ClaudeCodeCheckBinaryResult> => {
    return binaryProber(input)
  }

  const resolveSlug = async (
    input: ClaudeCodeResolveSlugInput,
  ): Promise<ClaudeCodeResolveSlugResult> => {
    try {
      const realPath = await realpath(input.projectDir)
      const slug = projectSlugForRealpath(realPath)
      return { ok: true, realPath, slug }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  const onEvent = (listener: ManagerEventListener): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const stopAll = async (): Promise<void> => {
    const watcherStops = Array.from(attached.values(), entry => entry.watcher.stop())
    const runnerStops = Array.from(runners.values(), runner => runner.stop())
    attached.clear()
    runners.clear()
    await Promise.allSettled([...watcherStops, ...runnerStops])
  }

  return {
    listSessions,
    attachSession,
    detachSession,
    sendPrompt,
    checkBinary,
    resolveSlug,
    onEvent,
    stopAll,
  }
}

export type { ClaudeCodeSession, ClaudeCodeSessionMeta, NormalizedClaudeCodeEvent }
