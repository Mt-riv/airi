interface BaseCronJob {
  id: string
  name: string
  prompt: string
  sessionId?: string
  enabled: boolean
  skillId?: string
  timezone?: string
  lastRunAt?: string
  nextRunAt?: string
}

export interface RecurringCronJob extends BaseCronJob {
  kind: 'cron'
  cron: string
}

export interface OneshotCronJob extends BaseCronJob {
  kind: 'oneshot'
  /** ISO-8601 timestamp of when this job should fire once. */
  fireAt: string
}

export type CronJob = RecurringCronJob | OneshotCronJob

export type CronJobInput = Omit<RecurringCronJob, 'nextRunAt' | 'lastRunAt'> | Omit<OneshotCronJob, 'nextRunAt' | 'lastRunAt'>

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
  addJob: (job: CronJobInput) => Promise<CronJob>
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
