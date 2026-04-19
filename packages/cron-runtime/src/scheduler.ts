import type { Clock, CreateSchedulerOptions, CronJob, CronScheduler, CronTriggerEvent, JobStore } from './types'

import { errorMessageFrom } from '@moeru/std'
import { CronExpressionParser } from 'cron-parser'

function computeNextRunAt(job: CronJob, now: number): Date | null {
  if (job.kind === 'oneshot') {
    const t = Date.parse(job.fireAt)
    if (!Number.isFinite(t) || t <= now) {
      return null
    }
    return new Date(t)
  }

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

      const current = cache[jobIndex]
      const firedJob: CronJob = {
        ...current,
        lastRunAt: firedAt.toISOString(),
        nextRunAt: computeNextRunAt(current, clock.now())?.toISOString(),
      }

      // NOTICE: oneshot jobs are fire-and-forget; remove from cache after
      // trigger so they never fire twice and don't linger in jobs.json.
      if (current.kind === 'oneshot') {
        cache = cache.filter((_, i) => i !== jobIndex)
      }
      else {
        cache = cache.map((j, i) => i === jobIndex ? firedJob : j)
      }

      // Fire-and-forget persistence — save errors must not block or throw from
      // inside the synchronous timer callback.
      store.save([...cache]).catch((err: unknown) => {
        console.warn(`[cron-runtime] Failed to persist jobs after trigger: ${errorMessageFrom(err)}`)
      })

      onTrigger({ job: firedJob, firedAt, scheduledFor })
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
      // NOTICE: Dedup by job id (last-write wins). A historical bug where
      // multiple windows each registered their own eventa invoke handler
      // caused `addJob` to be dispatched N times per UI click, persisting
      // N duplicates of the same job into jobs.json. That root cause is
      // fixed elsewhere, but previously-installed users still have those
      // duplicates on disk. Collapsing here lets the next save() overwrite
      // jobs.json with the cleaned list.
      const deduped = new Map<string, CronJob>()
      for (const j of jobs) deduped.set(j.id, j)
      // Drop stale oneshot jobs whose fireAt has already passed — otherwise
      // they'd stay in jobs.json forever with nextRunAt=undefined.
      const now = clock.now()
      const surviving = Array.from(deduped.values()).filter((j) => {
        if (j.kind !== 'oneshot')
          return true
        const t = Date.parse(j.fireAt)
        return Number.isFinite(t) && t > now
      })
      cache = surviving.map(j => (j.enabled ? withNextRunAt(j, now) : j))
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
