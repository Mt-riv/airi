import type { CronJob, CronScheduler } from '@proj-airi/cron-runtime'
import type { SkillDefinition } from '@proj-airi/skill-registry'

import type { AgentRuntimeStatus } from '../../../../shared/agent-runtime'

export interface SkillsManager {
  list: () => SkillDefinition[]
  reload: () => Promise<SkillDefinition[]>
}

export interface CronBroadcastPayload {
  jobId: string
  turnId: string
  prompt: string
  skillId?: string
}

export type CronBroadcaster = (payload: CronBroadcastPayload) => void

export interface AgentManager {
  isEnabled: () => boolean
  setEnabled: (enabled: boolean) => Promise<void>
  status: () => AgentRuntimeStatus
  listSkills: () => SkillDefinition[]
  reloadSkills: () => Promise<SkillDefinition[]>
  listCronJobs: () => Promise<CronJob[]>
  addCronJob: (job: Omit<CronJob, 'nextRunAt' | 'lastRunAt'>) => Promise<CronJob>
  removeCronJob: (id: string) => Promise<void>
  toggleCronJob: (id: string, enabled: boolean) => Promise<CronJob>
  registerCronBroadcaster: (broadcaster: CronBroadcaster) => () => void
  stopAll: () => Promise<void>
}

export interface CreateAgentManagerDeps {
  skills: SkillsManager
  cron: CronScheduler
  persistEnabled: (enabled: boolean) => Promise<void>
  initialEnabled: boolean
}
