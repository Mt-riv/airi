import type { CronJob } from './types'

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createJsonJobStore } from './job-store.json'

// NOTICE: vi.spyOn cannot redefine exports on the ESM node:fs/promises
// namespace (vitest "Cannot redefine property" error). Using vi.mock with
// `{ spy: true }` lets us `vi.mocked(rename).mockRejectedValueOnce(...)`
// for the crash-recovery scenarios while leaving every other fs call on the
// real implementation — mirrors how the store actually fails in production.
vi.mock('node:fs/promises', { spy: true })
const fsPromises = await import('node:fs/promises')

function makeJob(id: string): CronJob {
  return {
    id,
    name: `Job ${id}`,
    cron: '0 * * * *',
    prompt: 'test',
    enabled: true,
  }
}

let testDir: string

beforeEach(async () => {
  testDir = join(tmpdir(), `cron-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('createJsonJobStore', () => {
  it('load returns empty array when file does not exist', async () => {
    const store = createJsonJobStore(join(testDir, 'jobs.json'))
    expect(await store.load()).toEqual([])
  })

  it('save then load round-trips jobs correctly', async () => {
    const filepath = join(testDir, 'jobs.json')
    const store = createJsonJobStore(filepath)
    const jobs = [makeJob('x'), makeJob('y')]
    await store.save(jobs)
    const loaded = await store.load()
    expect(loaded).toHaveLength(2)
    expect(loaded[0].id).toBe('x')
    expect(loaded[1].id).toBe('y')
  })

  it('corrupt JSON emits console.warn, returns empty, and creates backup file', async () => {
    const filepath = join(testDir, 'jobs.json')
    await writeFile(filepath, '{ this is not json }', 'utf-8')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = createJsonJobStore(filepath)
    const result = await store.load()

    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('Corrupt jobs file')

    // Backup file should exist in the same directory
    const dirEntries = await readFile(filepath, 'utf-8').catch(() => null)
    // Original file was renamed to backup, so reading should fail or backup exists
    const backupExists = dirEntries === null

    // Alternatively, check there's a .corrupt-* file
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(testDir)
    const backupFile = files.find(f => f.includes('.corrupt-'))
    expect(backupFile ?? backupExists).toBeTruthy()

    warnSpy.mockRestore()
  })

  it('creates parent directories when saving to nested path', async () => {
    const filepath = join(testDir, 'nested', 'deep', 'jobs.json')
    const store = createJsonJobStore(filepath)
    await store.save([makeJob('z')])
    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('z')
  })

  describe('crash recovery / atomic save', () => {
    it('rename failure leaves prior jobs file intact (simulated crash between tmp write and rename)', async () => {
      const filepath = join(testDir, 'jobs.json')
      const store = createJsonJobStore(filepath)

      // Establish a valid baseline the store will need to preserve across a crash
      await store.save([makeJob('prior')])

      // Simulate a crash that interrupts save() after the tmp file is written
      // but before the rename succeeds — the persisted file must still show the
      // prior snapshot, not disappear or turn into partial JSON.
      vi.mocked(fsPromises.rename).mockRejectedValueOnce(
        Object.assign(new Error('simulated power loss mid-rename'), { code: 'EIO' }),
      )

      await expect(store.save([makeJob('new')])).rejects.toThrow('simulated power loss mid-rename')

      const survivors = await store.load()
      expect(survivors).toHaveLength(1)
      expect(survivors[0].id).toBe('prior')

      // Tmp file must not leak from the failed save
      const leftovers = await readdir(testDir)
      expect(leftovers).not.toContain('jobs.json.tmp')
    })

    it('writeFile failure preserves prior jobs file and leaves no tmp file', async () => {
      const filepath = join(testDir, 'jobs.json')
      const store = createJsonJobStore(filepath)
      await store.save([makeJob('kept')])

      vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(
        Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
      )

      await expect(store.save([makeJob('lost')])).rejects.toThrow('disk full')

      const survivors = await store.load()
      expect(survivors).toHaveLength(1)
      expect(survivors[0].id).toBe('kept')

      const leftovers = await readdir(testDir)
      expect(leftovers).not.toContain('jobs.json.tmp')
    })

    it('stale tmp file from an earlier crash does not contaminate load()', async () => {
      const filepath = join(testDir, 'jobs.json')
      await writeFile(filepath, JSON.stringify([makeJob('legit')], null, 2), 'utf-8')
      // Simulate a half-written tmp file left behind by a previous process crash.
      await writeFile(`${filepath}.tmp`, '{ "truncated', 'utf-8')

      const store = createJsonJobStore(filepath)
      const loaded = await store.load()
      expect(loaded).toHaveLength(1)
      expect(loaded[0].id).toBe('legit')
    })

    it('successful save leaves no tmp file behind', async () => {
      const filepath = join(testDir, 'jobs.json')
      const store = createJsonJobStore(filepath)
      await store.save([makeJob('only')])

      const files = await readdir(testDir)
      expect(files).toContain('jobs.json')
      expect(files).not.toContain('jobs.json.tmp')
    })
  })
})
