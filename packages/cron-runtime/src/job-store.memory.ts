import type { CronJob, JobStore } from './types'

export function createMemoryJobStore(): JobStore {
  const jobs = new Map<string, CronJob>()

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
