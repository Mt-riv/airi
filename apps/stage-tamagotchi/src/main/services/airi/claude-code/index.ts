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
  ClaudeCodeProjectSessionsSummary,
  ClaudeCodeProjectSummary,
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
  tailOnly?: boolean
}

export interface AttachSessionBySlugInput {
  sessionId: string
  slug: string
  tailOnly?: boolean
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
  listAllProjects: () => Promise<ClaudeCodeProjectSummary[]>
  listAllSessions: () => Promise<ClaudeCodeProjectSessionsSummary[]>
  attachSession: (input: AttachSessionInput) => Promise<ClaudeCodeSessionMeta>
  attachSessionBySlug: (input: AttachSessionBySlugInput) => Promise<ClaudeCodeSessionMeta>
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

  const attachInternal = async (
    { sessionId, slug, filePath, cwd, tailOnly }: {
      sessionId: string
      slug: string
      filePath: string
      cwd?: string
      tailOnly?: boolean
    },
  ): Promise<ClaudeCodeSessionMeta> => {
    const existing = attached.get(sessionId)
    if (existing)
      return existing.meta

    const meta: ClaudeCodeSessionMeta = {
      sessionId,
      slug,
      filePath,
      cwd,
      eventCount: 0,
    }

    const watcher = createSessionWatcher({
      filePath,
      tailOnly,
      onEvent: (event) => {
        meta.eventCount += 1
        emit(sessionId, event)
      },
    })

    attached.set(sessionId, { meta, watcher })
    await watcher.start()
    return meta
  }

  const attachSession = async ({ sessionId, projectDir, tailOnly }: AttachSessionInput): Promise<ClaudeCodeSessionMeta> => {
    const existing = attached.get(sessionId)
    if (existing)
      return existing.meta

    const { slug, slugDir } = await slugDirFor(projectDir)
    const filePath = join(slugDir, `${sessionId}.jsonl`)
    return attachInternal({ sessionId, slug, filePath, cwd: projectDir, tailOnly })
  }

  const attachSessionBySlug = async ({ sessionId, slug, tailOnly }: AttachSessionBySlugInput): Promise<ClaudeCodeSessionMeta> => {
    const existing = attached.get(sessionId)
    if (existing)
      return existing.meta

    const filePath = join(claudeProjectsRoot, slug, `${sessionId}.jsonl`)
    return attachInternal({ sessionId, slug, filePath, tailOnly })
  }

  // Enumerate every `<slug>/<session>.jsonl` beneath `claudeProjectsRoot`
  // and return them grouped by slug, each slug's sessions sorted by mtime
  // desc (tie-broken on sessionId). Shared between `listAllProjects` (which
  // only surfaces the latest per slug) and `listAllSessions` (which returns
  // all of them). Returns `[]` when the root directory does not exist.
  const collectSlugSessions = async (): Promise<ClaudeCodeProjectSessionsSummary[]> => {
    let slugEntries: string[]
    try {
      slugEntries = await readdir(claudeProjectsRoot)
    }
    catch {
      return []
    }

    const summaries = await Promise.all(slugEntries.map(async (slug): Promise<ClaudeCodeProjectSessionsSummary | null> => {
      const slugDir = join(claudeProjectsRoot, slug)
      const dirStat = await stat(slugDir).catch(() => null)
      if (dirStat == null || !dirStat.isDirectory())
        return null

      const files = await readdir(slugDir).catch((): string[] => [])
      const jsonlFiles = files.filter(name => name.endsWith('.jsonl'))
      if (jsonlFiles.length === 0)
        return { slug, sessions: [] }

      const statted = await Promise.all(jsonlFiles.map(async (name) => {
        const filePath = join(slugDir, name)
        const st = await stat(filePath).catch(() => null)
        return { name, filePath, mtime: st?.mtime ?? null }
      }))

      statted.sort((a, b) => {
        const left = a.mtime?.getTime() ?? 0
        const right = b.mtime?.getTime() ?? 0
        if (right !== left)
          return right - left
        return a.name.localeCompare(b.name)
      })

      const sessions: ClaudeCodeSessionMeta[] = statted.map(entry => ({
        sessionId: entry.name.replace(JSONL_EXTENSION_PATTERN, ''),
        slug,
        filePath: entry.filePath,
        lastEventAt: entry.mtime?.toISOString(),
        eventCount: 0,
      }))

      return { slug, sessions }
    }))

    return summaries.filter((entry): entry is ClaudeCodeProjectSessionsSummary => entry != null)
  }

  const listAllProjects = async (): Promise<ClaudeCodeProjectSummary[]> => {
    const all = await collectSlugSessions()

    const results: ClaudeCodeProjectSummary[] = all.map(({ slug, sessions }) => ({
      slug,
      latestSession: sessions[0] ?? null,
    }))

    // Sort newest-first so consumers that pick the "head" project get the
    // most recently active one without extra work.
    results.sort((a, b) => {
      const left = a.latestSession?.lastEventAt ?? ''
      const right = b.latestSession?.lastEventAt ?? ''
      const byMtime = right.localeCompare(left)
      if (byMtime !== 0)
        return byMtime
      return a.slug.localeCompare(b.slug)
    })

    return results
  }

  const listAllSessions = async (): Promise<ClaudeCodeProjectSessionsSummary[]> => {
    const all = await collectSlugSessions()

    // Sort projects by their newest session's mtime so recently-touched
    // projects float to the top of the manual-select picker.
    all.sort((a, b) => {
      const left = a.sessions[0]?.lastEventAt ?? ''
      const right = b.sessions[0]?.lastEventAt ?? ''
      const byMtime = right.localeCompare(left)
      if (byMtime !== 0)
        return byMtime
      return a.slug.localeCompare(b.slug)
    })

    return all
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
    listAllProjects,
    listAllSessions,
    attachSession,
    attachSessionBySlug,
    detachSession,
    sendPrompt,
    checkBinary,
    resolveSlug,
    onEvent,
    stopAll,
  }
}

export type { ClaudeCodeProjectSessionsSummary, ClaudeCodeProjectSummary, ClaudeCodeSession, ClaudeCodeSessionMeta, NormalizedClaudeCodeEvent }
