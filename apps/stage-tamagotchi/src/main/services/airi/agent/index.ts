import type { AgentManager, CreateAgentManagerDeps, CronBroadcaster } from './types'

import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'

export interface AgentManagerInternals {
  broadcastCronTrigger: (payload: { jobId: string, turnId: string, prompt: string, skillId?: string }) => void
}

export function createAgentManager(deps: CreateAgentManagerDeps): AgentManager & AgentManagerInternals {
  const { skills, cron, persistEnabled } = deps

  let enabled = deps.initialEnabled
  const broadcasters = new Set<CronBroadcaster>()

  const isEnabled = (): boolean => enabled

  const setEnabled = async (value: boolean): Promise<void> => {
    enabled = value
    await persistEnabled(value)
    if (value)
      await cron.start()
    else
      await cron.stop()
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
    listCronJobs: () => cron.listJobs(),
    addCronJob: job => cron.addJob(job),
    removeCronJob: id => cron.removeJob(id),
    toggleCronJob: (id, val) => cron.toggleJob(id, val),
    registerCronBroadcaster,
    stopAll,
    broadcastCronTrigger,
  }
}

export type { AgentManager } from './types'
