import type { CronJob } from '@proj-airi/cron-runtime'

import type { SkillsManager } from './types'

import { createCronScheduler, createFakeClock, createMemoryJobStore } from '@proj-airi/cron-runtime'
import { describe, expect, it, vi } from 'vitest'

import { createAgentManager } from './index'

// NOTICE: bootkit lifecycle registers onAppBeforeQuit handlers against
// electron.app, which is not present in the test runtime. Stubbing it here
// keeps the agent manager's cleanup hook registration a no-op without
// pulling Electron into the unit test.
vi.mock('../../../libs/bootkit/lifecycle', () => ({
  onAppBeforeQuit: () => {},
}))

function makeSkills(): SkillsManager {
  return {
    list: () => [],
    reload: async () => [],
  }
}

describe('createAgentManager × cron-runtime', () => {
  it('initialEnabled=true boot loads persisted jobs before addJob writes jobs.json', async () => {
    // Regression: without starting the scheduler on boot, the in-memory
    // cache starts empty and the first addJob() overwrites jobs.json with
    // just the new entry, silently destroying every prior cron job.
    const prior: CronJob = {
      id: 'prior',
      name: 'Prior',
      kind: 'cron',
      cron: '0 * * * *',
      prompt: 'keep me',
      enabled: true,
    }
    const store = createMemoryJobStore([prior])
    const clock = createFakeClock(1_000_000)
    const scheduler = createCronScheduler({ store, clock, onTrigger: () => {} })

    const manager = createAgentManager({
      skills: makeSkills(),
      cron: scheduler,
      persistEnabled: async () => {},
      initialEnabled: true,
    })

    // First IPC-like call after boot: list before add. Must reflect the
    // persisted baseline, not an empty cache.
    const before = await manager.listCronJobs()
    expect(before.map(j => j.id)).toEqual(['prior'])

    const added = await manager.addCronJob({
      id: 'new',
      name: 'New',
      kind: 'cron',
      cron: '*/5 * * * *',
      prompt: 'freshly added',
      enabled: true,
    })

    expect(added.id).toBe('new')

    const after = await manager.listCronJobs()
    expect(after.map(j => j.id).sort()).toEqual(['new', 'prior'])

    const persisted = await store.load()
    expect(persisted.map(j => j.id).sort()).toEqual(['new', 'prior'])
  })

  it('newly added job fires on schedule after boot with initialEnabled=true', async () => {
    const store = createMemoryJobStore([])
    const clock = createFakeClock(Date.UTC(2026, 0, 1, 11, 59, 55))
    const triggered: string[] = []
    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: event => triggered.push(event.job.id),
    })

    const manager = createAgentManager({
      skills: makeSkills(),
      cron: scheduler,
      persistEnabled: async () => {},
      initialEnabled: true,
    })

    await manager.addCronJob({
      id: 'hourly',
      name: 'Hourly',
      kind: 'cron',
      cron: '0 * * * *',
      prompt: 'fire-me',
      enabled: true,
    })

    // Advance across the next top-of-hour. Without cron.start() on boot the
    // timer is never armed, so this would silently fail.
    clock.advance(10 * 1000)
    expect(triggered).toEqual(['hourly'])
  })

  it('initialEnabled=false does not start the scheduler (addJob blocked upstream)', async () => {
    const store = createMemoryJobStore([
      { id: 'ghost', name: 'Ghost', kind: 'cron', cron: '0 * * * *', prompt: 'nope', enabled: true },
    ])
    const clock = createFakeClock(0)
    const onTrigger = vi.fn()
    const scheduler = createCronScheduler({ store, clock, onTrigger })

    const manager = createAgentManager({
      skills: makeSkills(),
      cron: scheduler,
      persistEnabled: async () => {},
      initialEnabled: false,
    })

    // Disabled boot: cron cache stays empty until setEnabled(true).
    const jobs = await manager.listCronJobs()
    expect(jobs).toEqual([])

    clock.advance(60 * 60 * 1000)
    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('setEnabled(true) after a disabled boot loads persisted jobs', async () => {
    const store = createMemoryJobStore([
      { id: 'preexisting', name: 'Preexisting', kind: 'cron', cron: '0 * * * *', prompt: 'x', enabled: true },
    ])
    const clock = createFakeClock(0)
    const scheduler = createCronScheduler({ store, clock, onTrigger: () => {} })

    let persistedValue: boolean | null = null
    const manager = createAgentManager({
      skills: makeSkills(),
      cron: scheduler,
      persistEnabled: async (val) => { persistedValue = val },
      initialEnabled: false,
    })

    expect(await manager.listCronJobs()).toEqual([])

    await manager.setEnabled(true)

    expect(persistedValue).toBe(true)
    const jobs = await manager.listCronJobs()
    expect(jobs.map(j => j.id)).toEqual(['preexisting'])
  })
})
