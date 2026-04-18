import type { CronJob, JobStore } from './types'

export function createMemoryJobStore(initial: CronJob[] = []): JobStore {
  const jobs = new Map<string, CronJob>()
  for (const job of initial) {
    jobs.set(job.id, job)
  }

  return {
    async load() {
      return Array.from(jobs.values())
    },

    async save(updated) {
      jobs.clear()
      for (const job of updated) {
        jobs.set(job.id, job)
      }
    },
  }
}
