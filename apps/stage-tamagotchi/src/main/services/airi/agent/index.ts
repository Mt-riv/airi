import type { AgentManager, CreateAgentManagerDeps, CronBroadcaster } from './types'

import { errorMessageFrom } from '@moeru/std'

import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'

export interface AgentManagerInternals {
  broadcastCronTrigger: (payload: { jobId: string, turnId: string, prompt: string, skillId?: string }) => void
}

export function createAgentManager(deps: CreateAgentManagerDeps): AgentManager & AgentManagerInternals {
  const { skills, cron, persistEnabled } = deps

  let enabled = deps.initialEnabled
  const broadcasters = new Set<CronBroadcaster>()

  // NOTICE: cronReady gates every mutator on the scheduler. When the app boots
  // with `agentRuntime.enabled=true` persisted, the scheduler must call
  // `start()` so its in-memory cache is populated from `jobs.json` before any
  // addJob/toggleJob runs. Skipping that step would let a subsequent
  // `cron.addJob(...)` overwrite `jobs.json` with only the new entry (every
  // prior job silently lost) and leave the timer un-armed because the
  // scheduler never flipped `running` to true.
  let cronReady: Promise<void> = enabled
    ? cron.start().catch((err: unknown) => {
        console.warn(`[agent-runtime] cron.start failed on boot: ${errorMessageFrom(err)}`)
      })
    : Promise.resolve()

  const isEnabled = (): boolean => enabled

  const setEnabled = async (value: boolean): Promise<void> => {
    enabled = value
    await persistEnabled(value)
    cronReady = value ? cron.start() : cron.stop()
    await cronReady
  }

  // NOTICE: cronJobsEnabled is always 0 here because listJobs() is async.
  // The IPC handler in electron-service.ts resolves the actual count.
  const status = () => ({
    enabled,
    skillsLoaded: skills.list().length,
    cronJobsEnabled: 0,
    activeTurns: 0,
  })

  const registerCronBroadcaster = (broadcaster: CronBroadcaster): (() => void) => {
    broadcasters.add(broadcaster)
    return () => {
      broadcasters.delete(broadcaster)
    }
  }

  const broadcastCronTrigger = (payload: { jobId: string, turnId: string, prompt: string, skillId?: string }) => {
    for (const b of broadcasters) {
      try {
        b(payload)
      }
      catch {
        // Individual broadcaster failures must not affect others.
      }
    }
  }

  const stopAll = async (): Promise<void> => {
    enabled = false
    await cron.stop()
  }

  onAppBeforeQuit(async () => {
    await stopAll()
  })

  return {
    isEnabled,
    setEnabled,
    status,
    listSkills: () => skills.list(),
    reloadSkills: () => skills.reload(),
    listCronJobs: async () => {
      await cronReady
      return cron.listJobs()
    },
    addCronJob: async (job) => {
      await cronReady
      return cron.addJob(job)
    },
    removeCronJob: async (id) => {
      await cronReady
      return cron.removeJob(id)
    },
    toggleCronJob: async (id, val) => {
      await cronReady
      return cron.toggleJob(id, val)
    },
    registerCronBroadcaster,
    stopAll,
    broadcastCronTrigger,
  }
}

export type { AgentManager } from './types'
