import type { CronJob, CronJobInput, CronTriggerEvent } from './types'

import { describe, expect, it, vi } from 'vitest'

import { createFakeClock } from './clock'
import { createMemoryJobStore } from './job-store.memory'
import { createCronScheduler } from './scheduler'

// Start virtual time at a known epoch: 2024-01-01 00:00:00 UTC
const BASE_TIME = new Date('2024-01-01T00:00:00Z').getTime()

function makeJob(overrides: Partial<CronJob> = {}): CronJobInput {
  return {
    id: 'job-1',
    name: 'Test Job',
    kind: 'cron',
    cron: '*/1 * * * *',
    prompt: 'test prompt',
    enabled: true,
    ...overrides,
  } as CronJobInput
}

function makeOneshot(overrides: Partial<CronJob> = {}): CronJobInput {
  return {
    id: 'timer-1',
    name: 'Test Timer',
    kind: 'oneshot',
    fireAt: new Date(BASE_TIME + 60_000).toISOString(),
    prompt: 'timer prompt',
    enabled: true,
    ...overrides,
  } as CronJobInput
}

describe('createCronScheduler', () => {
  it('triggers a single job at the expected next minute', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()
    const events: CronTriggerEvent[] = []

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: e => events.push(e),
    })

    await scheduler.start()
    await scheduler.addJob(makeJob())

    // Next run for '*/1 * * * *' from 00:00:00 is 00:01:00 — 60 000 ms ahead
    clock.advance(60_000)

    expect(events).toHaveLength(1)
    expect(events[0].job.id).toBe('job-1')
    expect(events[0].firedAt.getTime()).toBe(BASE_TIME + 60_000)
  })

  it('does not trigger disabled jobs', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()
    const events: CronTriggerEvent[] = []

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: e => events.push(e),
    })

    await scheduler.start()
    await scheduler.addJob(makeJob({ enabled: false }))
    clock.advance(120_000)

    expect(events).toHaveLength(0)
  })

  it('fires the nearest job first when two jobs are scheduled', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()
    const fired: string[] = []

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: e => fired.push(e.job.id),
    })

    await scheduler.start()
    // Every minute
    await scheduler.addJob(makeJob({ id: 'every-minute', cron: '*/1 * * * *' }))
    // Every 5 minutes
    await scheduler.addJob(makeJob({ id: 'every-5-min', cron: '*/5 * * * *' }))

    // Advance 1 minute — only every-minute should fire
    clock.advance(60_000)
    expect(fired).toContain('every-minute')
    expect(fired).not.toContain('every-5-min')

    // Advance 4 more minutes — every-5-min fires at 5 min mark
    clock.advance(240_000)
    expect(fired).toContain('every-5-min')
  })

  it('addJob while running schedules the new job immediately', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()
    const events: CronTriggerEvent[] = []

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: e => events.push(e),
    })

    await scheduler.start()
    clock.advance(30_000)
    // Add a new job mid-run — it should schedule for next minute from current virtual time
    await scheduler.addJob(makeJob({ id: 'late-add' }))
    // Next tick after 30s start is 60s mark (30s away)
    clock.advance(30_000)

    expect(events.some(e => e.job.id === 'late-add')).toBe(true)
  })

  it('removeJob while running cancels any pending trigger for that job', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()
    const events: CronTriggerEvent[] = []

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: e => events.push(e),
    })

    await scheduler.start()
    await scheduler.addJob(makeJob())
    await scheduler.removeJob('job-1')
    clock.advance(120_000)

    expect(events).toHaveLength(0)
  })

  it('stop() prevents further triggers', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()
    const events: CronTriggerEvent[] = []

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: e => events.push(e),
    })

    await scheduler.start()
    await scheduler.addJob(makeJob())
    await scheduler.stop()
    clock.advance(120_000)

    expect(events).toHaveLength(0)
  })

  it('toggleJob re-enables a disabled job and triggers it', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()
    const events: CronTriggerEvent[] = []

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: e => events.push(e),
    })

    await scheduler.start()
    await scheduler.addJob(makeJob({ enabled: false }))
    await scheduler.toggleJob('job-1', true)
    clock.advance(60_000)

    expect(events.some(e => e.job.id === 'job-1')).toBe(true)
  })

  it('addJob returns job with nextRunAt populated', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: () => {},
    })

    await scheduler.start()
    const job = await scheduler.addJob(makeJob())

    expect(job.nextRunAt).toBeTruthy()
    const nextRunAt = new Date(job.nextRunAt!)
    expect(nextRunAt.getTime()).toBeGreaterThan(BASE_TIME)
  })

  it('start() is idempotent — calling twice does not double-schedule', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()
    const events: CronTriggerEvent[] = []

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: e => events.push(e),
    })

    await scheduler.start()
    await scheduler.start()
    await scheduler.addJob(makeJob())
    clock.advance(60_000)

    // Should fire exactly once, not twice
    expect(events).toHaveLength(1)
  })

  it('listJobs returns all stored jobs', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: () => {},
    })

    await scheduler.start()
    await scheduler.addJob(makeJob({ id: 'a' }))
    await scheduler.addJob(makeJob({ id: 'b' }))
    const jobs = await scheduler.listJobs()
    expect(jobs.map(j => j.id)).toContain('a')
    expect(jobs.map(j => j.id)).toContain('b')
  })

  it('onTrigger updates lastRunAt and nextRunAt after firing', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()
    const events: CronTriggerEvent[] = []

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: e => events.push(e),
    })

    await scheduler.start()
    await scheduler.addJob(makeJob())
    clock.advance(60_000)

    expect(events).toHaveLength(1)
    const firedJob = events[0].job
    expect(firedJob.lastRunAt).toBeTruthy()
    expect(firedJob.nextRunAt).toBeTruthy()
    // nextRunAt should be after lastRunAt
    expect(new Date(firedJob.nextRunAt!).getTime()).toBeGreaterThan(new Date(firedJob.lastRunAt!).getTime())
  })

  it('re-triggers on second interval after first fire', async () => {
    const clock = createFakeClock(BASE_TIME)
    const store = createMemoryJobStore()
    const onTrigger = vi.fn()

    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger,
    })

    await scheduler.start()
    await scheduler.addJob(makeJob())
    clock.advance(60_000)
    clock.advance(60_000)

    expect(onTrigger).toHaveBeenCalledTimes(2)
  })

  describe('oneshot jobs', () => {
    it('fires a oneshot job at fireAt and removes it from the cache', async () => {
      const clock = createFakeClock(BASE_TIME)
      const store = createMemoryJobStore()
      const events: CronTriggerEvent[] = []

      const scheduler = createCronScheduler({
        store,
        clock,
        onTrigger: e => events.push(e),
      })

      await scheduler.start()
      await scheduler.addJob(makeOneshot())
      clock.advance(60_000)

      expect(events).toHaveLength(1)
      expect(events[0].job.id).toBe('timer-1')
      expect(events[0].firedAt.getTime()).toBe(BASE_TIME + 60_000)

      const remaining = await scheduler.listJobs()
      expect(remaining).toHaveLength(0)
    })

    it('does not re-fire a oneshot job after its fireAt elapses', async () => {
      const clock = createFakeClock(BASE_TIME)
      const store = createMemoryJobStore()
      const onTrigger = vi.fn()

      const scheduler = createCronScheduler({ store, clock, onTrigger })

      await scheduler.start()
      await scheduler.addJob(makeOneshot())
      clock.advance(60_000)
      clock.advance(60_000)
      clock.advance(60_000)

      expect(onTrigger).toHaveBeenCalledTimes(1)
    })

    it('persists cache omitting fired oneshot after trigger', async () => {
      const clock = createFakeClock(BASE_TIME)
      const store = createMemoryJobStore()

      const scheduler = createCronScheduler({ store, clock, onTrigger: () => {} })

      await scheduler.start()
      await scheduler.addJob(makeOneshot())
      clock.advance(60_000)
      // Wait a microtask for the fire-and-forget persistence to flush.
      await new Promise(resolve => setTimeout(resolve, 0))

      const persisted = await store.load()
      expect(persisted).toHaveLength(0)
    })

    it('drops oneshot jobs whose fireAt already passed at start()', async () => {
      const stalePast = new Date(BASE_TIME - 60_000).toISOString()
      const store = createMemoryJobStore()
      await store.save([
        {
          id: 'stale-1',
          name: 'Stale',
          kind: 'oneshot',
          fireAt: stalePast,
          prompt: 'test',
          enabled: true,
        },
      ])

      const clock = createFakeClock(BASE_TIME)
      const onTrigger = vi.fn()
      const scheduler = createCronScheduler({ store, clock, onTrigger })

      await scheduler.start()
      clock.advance(60_000 * 60)

      expect(onTrigger).not.toHaveBeenCalled()
      expect(await scheduler.listJobs()).toHaveLength(0)
    })

    it('fires a oneshot loaded from the store at fireAt', async () => {
      const store = createMemoryJobStore()
      await store.save([
        {
          id: 'pre-1',
          name: 'Pre-existing',
          kind: 'oneshot',
          fireAt: new Date(BASE_TIME + 120_000).toISOString(),
          prompt: 'test',
          enabled: true,
        },
      ])

      const clock = createFakeClock(BASE_TIME)
      const events: CronTriggerEvent[] = []
      const scheduler = createCronScheduler({
        store,
        clock,
        onTrigger: e => events.push(e),
      })

      await scheduler.start()
      clock.advance(120_000)

      expect(events).toHaveLength(1)
      expect(events[0].job.id).toBe('pre-1')
    })

    it('fires nearest job first regardless of kind', async () => {
      const clock = createFakeClock(BASE_TIME)
      const store = createMemoryJobStore()
      const fired: string[] = []
      const scheduler = createCronScheduler({
        store,
        clock,
        onTrigger: e => fired.push(e.job.id),
      })

      await scheduler.start()
      // cron job fires at 60s mark
      await scheduler.addJob(makeJob({ id: 'cron-minute' }))
      // oneshot fires at 30s mark — sooner
      await scheduler.addJob(makeOneshot({ id: 'timer-30s', fireAt: new Date(BASE_TIME + 30_000).toISOString() }))

      clock.advance(30_000)
      expect(fired).toEqual(['timer-30s'])

      clock.advance(30_000)
      expect(fired).toContain('cron-minute')
    })
  })
})
