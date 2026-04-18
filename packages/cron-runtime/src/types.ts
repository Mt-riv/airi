export interface CronJob {
  id: string
  name: string
  cron: string
  prompt: string
  sessionId?: string
  enabled: boolean
  skillId?: string
  timezone?: string
  lastRunAt?: string
  nextRunAt?: string
}

export interface CronTriggerEvent {
  job: CronJob
  firedAt: Date
  scheduledFor: Date
}

export interface JobStore {
  load: () => Promise<CronJob[]>
  save: (jobs: CronJob[]) => Promise<void>
}

export interface CronScheduler {
  start: () => Promise<void>
  stop: () => Promise<void>
  addJob: (job: Omit<CronJob, 'nextRunAt' | 'lastRunAt'>) => Promise<CronJob>
  removeJob: (id: string) => Promise<void>
  listJobs: () => Promise<CronJob[]>
  toggleJob: (id: string, enabled: boolean) => Promise<CronJob>
}

export interface Clock {
  now: () => number
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface CreateSchedulerOptions {
  store: JobStore
  clock: Clock
  onTrigger: (event: CronTriggerEvent) => void
}
