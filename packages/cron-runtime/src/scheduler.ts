import type { Clock, CreateSchedulerOptions, CronJob, CronScheduler, CronTriggerEvent, JobStore } from './types'

import { errorMessageFrom } from '@moeru/std'
import { CronExpressionParser } from 'cron-parser'

function computeNextRunAt(job: CronJob, now: number): Date | null {
  try {
    const expr = CronExpressionParser.parse(job.cron, {
      currentDate: new Date(now),
      tz: job.timezone,
    })
    return expr.next().toDate()
  }
  catch {
    return null
  }
}

function withNextRunAt(job: CronJob, now: number): CronJob {
  const next = computeNextRunAt(job, now)
  return { ...job, nextRunAt: next?.toISOString() }
}

export function createCronScheduler(options: CreateSchedulerOptions): CronScheduler {
  const { store, clock, onTrigger }: { store: JobStore, clock: Clock, onTrigger: (event: CronTriggerEvent) => void } = options

  let timerHandle: unknown = null
  let running = false
  // NOTICE: In-memory jobs cache is authoritative during runtime. The timer
  // callback must be synchronous so FakeClock.advance() can observe trigger
  // results deterministically — loading from the store inside the callback
  // would break that.
  let cache: CronJob[] = []

  function reschedule(): void {
    if (timerHandle !== null) {
      clock.clearTimeout(timerHandle)
      timerHandle = null
    }

    if (!running) {
      return
    }

    const enabled = cache.filter(j => j.enabled && j.nextRunAt != null)
    if (enabled.length === 0) {
      return
    }

    const nearest = enabled.reduce<CronJob>((a, b) =>
      (a.nextRunAt! < b.nextRunAt!) ? a : b, enabled[0])

    const scheduledFor = new Date(nearest.nextRunAt!)
    const delay = Math.max(0, scheduledFor.getTime() - clock.now())

    timerHandle = clock.setTimeout(() => {
      if (!running) {
        return
      }

      const firedAt = new Date(clock.now())
      const jobIndex = cache.findIndex(j => j.id === nearest.id)
      if (jobIndex === -1 || !cache[jobIndex].enabled) {
        reschedule()
        return
      }

      const updatedJob: CronJob = {
        ...cache[jobIndex],
        lastRunAt: firedAt.toISOString(),
        nextRunAt: computeNextRunAt(cache[jobIndex], clock.now())?.toISOString(),
      }

      cache = cache.map((j, i) => i === jobIndex ? updatedJob : j)

      // Fire-and-forget persistence — save errors must not block or throw from
      // inside the synchronous timer callback.
      store.save([...cache]).catch((err: unknown) => {
        console.warn(`[cron-runtime] Failed to persist jobs after trigger: ${errorMessageFrom(err)}`)
      })

      onTrigger({ job: updatedJob, firedAt, scheduledFor })
      reschedule()
    }, delay)
  }

  async function persistAndReschedule(): Promise<void> {
    await store.save([...cache])
    if (running) {
      reschedule()
    }
  }

  return {
    async start() {
      if (running) {
        return
      }
      running = true
      const jobs = await store.load()
      cache = jobs.map(j => (j.enabled ? withNextRunAt(j, clock.now()) : j))
      await store.save([...cache])
      reschedule()
    },

    async stop() {
      running = false
      if (timerHandle !== null) {
        clock.clearTimeout(timerHandle)
        timerHandle = null
      }
    },

    async addJob(jobInput) {
      const newJob: CronJob = jobInput.enabled
        ? withNextRunAt({ ...jobInput }, clock.now())
        : { ...jobInput }
      cache = [...cache, newJob]
      await persistAndReschedule()
      return newJob
    },

    async removeJob(id) {
      cache = cache.filter(j => j.id !== id)
      await persistAndReschedule()
    },

    async listJobs() {
      return [...cache]
    },

    async toggleJob(id, enabled) {
      const idx = cache.findIndex(j => j.id === id)
      if (idx === -1) {
        throw new Error(`Job not found: ${id}`)
      }
      const updated: CronJob = {
        ...cache[idx],
        enabled,
        nextRunAt: enabled ? computeNextRunAt(cache[idx], clock.now())?.toISOString() : undefined,
      }
      cache = cache.map((j, i) => i === idx ? updated : j)
      await persistAndReschedule()
      return updated
    },
  }
}
