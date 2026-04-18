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

export interface CreateAgentServiceParams {
  context: ReturnType<typeof createContext>['context']
  manager: AgentManager
}

export function createAgentService(params: CreateAgentServiceParams): () => void {
  const { context, manager } = params
  const log = useLogg('main/agent-runtime').useGlobalConfig()

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

  // Register this context as a cron-trigger broadcaster. When the scheduler
  // fires a job, main emits the event here; the renderer that owns this
  // context will run the harness locally.
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
