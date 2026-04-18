import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { AgentManagerInternals } from './index'
import type { AgentManager, SkillsManager } from './types'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandlers } from '@moeru/eventa'

import {
  agentRuntimeAddCronJob,
  agentRuntimeCronTriggered,
  agentRuntimeListCronJobs,
  agentRuntimeListSkills,
  agentRuntimeReloadSkills,
  agentRuntimeRemoveCronJob,
  agentRuntimeSetEnabled,
  agentRuntimeStatus,
  agentRuntimeToggleCronJob,
} from '../../../../shared/eventa'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'
import { setupCronManager } from '../cron'
import { createCronTriggerBridge } from '../cron/trigger-bridge'
import { createAgentManager } from './index'

export type { AgentManager } from './types'
export type AgentManagerWithInternals = AgentManager & AgentManagerInternals

export interface SetupAgentManagerOptions {
  initialEnabled: boolean
  skillsManager: SkillsManager
  persistEnabled: (enabled: boolean) => Promise<void>
}

export function setupAgentManager(options: SetupAgentManagerOptions): AgentManagerWithInternals {
  const log = useLogg('main/agent-runtime').useGlobalConfig()

  // NOTICE: The cron onTrigger callback references `manager` which isn't
  // constructed yet. We use a mutable ref so the closure captures it after
  // construction.
  let managerRef: (AgentManagerInternals) | undefined

  const cron = setupCronManager({
    onTrigger: (event) => {
      if (!managerRef)
        return
      const bridge = createCronTriggerBridge({
        broadcast: payload => managerRef!.broadcastCronTrigger(payload),
      })
      bridge(event)
    },
  })

  const manager = createAgentManager({
    skills: options.skillsManager,
    cron,
    persistEnabled: options.persistEnabled,
    initialEnabled: options.initialEnabled,
  })

  managerRef = manager

  onAppBeforeQuit(async () => {
    try {
      await manager.stopAll()
    }
    catch (error) {
      log.withError(error).warn('failed to stop agent manager during shutdown')
    }
  })

  return manager
}

export interface CreateAgentInvokeHandlersParams {
  context: ReturnType<typeof createContext>['context']
  manager: AgentManager
}

// NOTICE: Invoke handlers MUST be registered on a single shared ipcMain-only
// context, not per-window. Each `createContext(ipcMain, window)` installs its
// own `ipcMain.on('eventa-message', ...)` listener, and all such listeners
// fire on every renderer invoke. Registering this block per-window would
// cause `manager.addCronJob(payload)` (and every other mutator) to fire once
// per wired window — producing duplicate cron entries. See regression fix in
// `main/index.ts` where this is invoked exactly once at app startup.
export function createAgentInvokeHandlers(params: CreateAgentInvokeHandlersParams): void {
  const { context, manager } = params

  defineInvokeHandlers(context, {
    agentRuntimeStatus,
    agentRuntimeSetEnabled,
    agentRuntimeListSkills,
    agentRuntimeReloadSkills,
    agentRuntimeListCronJobs,
    agentRuntimeAddCronJob,
    agentRuntimeRemoveCronJob,
    agentRuntimeToggleCronJob,
  }, {
    agentRuntimeStatus: async () => {
      const s = manager.status()
      const jobs = await manager.listCronJobs()
      return {
        ...s,
        cronJobsEnabled: jobs.filter(j => j.enabled).length,
      }
    },

    agentRuntimeSetEnabled: async (payload) => {
      if (!payload)
        throw new Error('agentRuntimeSetEnabled: missing payload')
      await manager.setEnabled(payload.enabled)
      const s = manager.status()
      const jobs = await manager.listCronJobs()
      return {
        ...s,
        cronJobsEnabled: jobs.filter(j => j.enabled).length,
      }
    },

    agentRuntimeListSkills: async () => {
      if (!manager.isEnabled())
        return []
      return manager.listSkills()
    },

    agentRuntimeReloadSkills: async () => {
      if (!manager.isEnabled())
        return []
      return manager.reloadSkills()
    },

    agentRuntimeListCronJobs: async () => {
      if (!manager.isEnabled())
        return []
      return manager.listCronJobs()
    },

    agentRuntimeAddCronJob: async (payload) => {
      if (!payload)
        throw new Error('agentRuntimeAddCronJob: missing payload')
      if (!manager.isEnabled())
        throw new Error('agent-runtime-disabled')
      return manager.addCronJob(payload)
    },

    agentRuntimeRemoveCronJob: async (payload) => {
      if (!payload)
        return { ok: false }
      if (!manager.isEnabled())
        return { ok: false }
      await manager.removeCronJob(payload.id)
      return { ok: true }
    },

    agentRuntimeToggleCronJob: async (payload) => {
      if (!payload)
        throw new Error('agentRuntimeToggleCronJob: missing payload')
      if (!manager.isEnabled())
        throw new Error('agent-runtime-disabled')
      return manager.toggleCronJob(payload.id, payload.enabled)
    },
  })
}

export interface CreateAgentBroadcasterParams {
  context: ReturnType<typeof createContext>['context']
  manager: AgentManager
}

// Register a per-window cron-trigger broadcaster. When the scheduler fires a
// job, main emits the event on this window's context so the renderer that
// owns it runs the harness locally. Multiple broadcasters can coexist — each
// window should call this once with its own per-window eventa context.
export function createAgentBroadcaster(params: CreateAgentBroadcasterParams): () => void {
  const { context, manager } = params
  const log = useLogg('main/agent-runtime').useGlobalConfig()

  const unregister = manager.registerCronBroadcaster((payload) => {
    try {
      context.emit(agentRuntimeCronTriggered, payload)
    }
    catch (err) {
      log.withError(err).warn('failed to broadcast cron-triggered event')
    }
  })

  return () => {
    unregister()
  }
}
