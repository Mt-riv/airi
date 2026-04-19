import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { ClaudeCodeManager } from './index'

import { homedir } from 'node:os'
import { join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandlers } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'

import {
  claudeCodeAttachSession,
  claudeCodeAttachSessionBySlug,
  claudeCodeCheckBinary,
  claudeCodeDetachSession,
  claudeCodeListAllProjects,
  claudeCodeListAllSessions,
  claudeCodeListSessions,
  claudeCodeResolveSlug,
  claudeCodeSendPrompt,
  claudeCodeStreamEvent,
} from '../../../../shared/eventa'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'
import { createClaudeCodeManager } from './index'

export interface SetupClaudeCodeManagerOptions {
  /**
   * Absolute path to the `claude` binary. Defaults to `'claude'` so the
   * OS `PATH` resolves it. The validator in Phase 3 will check existence
   * before the user can activate the provider.
   */
  binaryPath?: string
  /**
   * Root directory Claude Code uses for per-project transcripts. Defaults
   * to `~/.claude/projects`. Override for tests or XDG-style installs.
   */
  claudeProjectsRoot?: string
}

/**
 * Injeca-friendly factory: builds a `ClaudeCodeManager` and registers a
 * shutdown hook so every active session watcher / runner is torn down on
 * app quit. Safe to call from the main `index.ts` dependency graph.
 */
export function setupClaudeCodeManager(options: SetupClaudeCodeManagerOptions = {}): ClaudeCodeManager {
  const log = useLogg('main/claude-code').useGlobalConfig()

  const manager = createClaudeCodeManager({
    binaryPath: options.binaryPath ?? 'claude',
    claudeProjectsRoot: options.claudeProjectsRoot ?? join(homedir(), '.claude', 'projects'),
  })

  onAppBeforeQuit(async () => {
    try {
      await manager.stopAll()
    }
    catch (error) {
      log.withError(error).warn('failed to stop claude-code manager during shutdown')
    }
  })

  return manager
}

export interface CreateClaudeCodeServiceParams {
  context: ReturnType<typeof createContext>['context']
  manager: ClaudeCodeManager
}

/**
 * Wire a `ClaudeCodeManager` into an Eventa context: register every
 * `claudeCode*` invoke handler and forward normalised events to the
 * renderer as a broadcast on `claudeCodeStreamEvent`. Returns an
 * unsubscribe function for the event forwarder so test suites can detach
 * cleanly.
 */
export function createClaudeCodeService(params: CreateClaudeCodeServiceParams): () => void {
  const { context, manager } = params
  const log = useLogg('main/claude-code').useGlobalConfig()

  defineInvokeHandlers(context, {
    claudeCodeListSessions,
    claudeCodeListAllProjects,
    claudeCodeListAllSessions,
    claudeCodeAttachSession,
    claudeCodeAttachSessionBySlug,
    claudeCodeDetachSession,
    claudeCodeSendPrompt,
    claudeCodeCheckBinary,
    claudeCodeResolveSlug,
  }, {
    claudeCodeListSessions: async (payload) => {
      if (!payload)
        throw new Error('claudeCodeListSessions: missing payload')
      return manager.listSessions({ projectDir: payload.projectDir })
    },
    claudeCodeListAllProjects: async () => {
      return manager.listAllProjects()
    },
    claudeCodeListAllSessions: async () => {
      return manager.listAllSessions()
    },
    claudeCodeAttachSession: async (payload) => {
      if (!payload)
        throw new Error('claudeCodeAttachSession: missing payload')
      return manager.attachSession({
        sessionId: payload.sessionId,
        projectDir: payload.projectDir,
      })
    },
    claudeCodeAttachSessionBySlug: async (payload) => {
      if (!payload)
        throw new Error('claudeCodeAttachSessionBySlug: missing payload')
      return manager.attachSessionBySlug({
        sessionId: payload.sessionId,
        slug: payload.slug,
        tailOnly: payload.tailOnly,
      })
    },
    claudeCodeDetachSession: async (payload) => {
      if (!payload)
        throw new Error('claudeCodeDetachSession: missing payload')
      await manager.detachSession({ sessionId: payload.sessionId })
    },
    claudeCodeSendPrompt: async (payload) => {
      if (!payload)
        throw new Error('claudeCodeSendPrompt: missing payload')
      try {
        return await manager.sendPrompt({
          projectDir: payload.projectDir,
          sessionId: payload.sessionId,
          text: payload.text,
        })
      }
      catch (error) {
        // Surface validation / spawn errors to the renderer as a structured
        // result instead of letting Eventa reject the invoke.
        return {
          ok: false,
          error: errorMessageFrom(error) ?? 'failed to send prompt',
          sessionId: payload.sessionId,
        }
      }
    },
    claudeCodeCheckBinary: async (payload) => {
      if (!payload)
        throw new Error('claudeCodeCheckBinary: missing payload')
      try {
        return await manager.checkBinary({ binaryPath: payload.binaryPath })
      }
      catch (error) {
        return { ok: false, error: errorMessageFrom(error) ?? 'failed to probe binary' }
      }
    },
    claudeCodeResolveSlug: async (payload) => {
      if (!payload)
        throw new Error('claudeCodeResolveSlug: missing payload')
      try {
        return await manager.resolveSlug({ projectDir: payload.projectDir })
      }
      catch (error) {
        return { ok: false, error: errorMessageFrom(error) ?? 'failed to resolve slug' }
      }
    },
  })

  const unsubscribe = manager.onEvent((sessionId, event) => {
    try {
      context.emit(claudeCodeStreamEvent, { sessionId, event })
    }
    catch (error) {
      log.withError(error).warn('failed to broadcast claude-code stream event')
    }
  })

  return unsubscribe
}
