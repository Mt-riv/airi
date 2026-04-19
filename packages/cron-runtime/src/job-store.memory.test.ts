import type { CronJob } from './types'

import { describe, expect, it } from 'vitest'

import { createMemoryJobStore } from './job-store.memory'

function makeJob(id: string): CronJob {
  return {
    id,
    name: `Job ${id}`,
    kind: 'cron',
    cron: '*/5 * * * *',
    prompt: 'hello',
    enabled: true,
  }
}

describe('createMemoryJobStore', () => {
  it('load returns empty array initially', async () => {
    const store = createMemoryJobStore()
    expect(await store.load()).toEqual([])
  })

  it('save then load returns saved jobs', async () => {
    const store = createMemoryJobStore()
    const jobs = [makeJob('a'), makeJob('b')]
    await store.save(jobs)
    const loaded = await store.load()
    expect(loaded).toHaveLength(2)
    expect(loaded.map(j => j.id)).toEqual(['a', 'b'])
  })

  it('save overwrites previous state', async () => {
    const store = createMemoryJobStore()
    await store.save([makeJob('a'), makeJob('b')])
    await store.save([makeJob('c')])
    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('c')
  })
})
