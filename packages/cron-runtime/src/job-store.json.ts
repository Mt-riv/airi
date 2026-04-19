import type { CronJob, JobStore } from './types'

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

// NOTICE: Jobs persisted before the `kind` field was introduced are read as
// recurring cron entries. This is a one-way data migration (next save() will
// rewrite them with `kind: 'cron'`), not a runtime guard — the rest of the
// runtime treats `kind` as required.
function migrateLegacyJob(raw: Record<string, unknown>): CronJob {
  if (raw.kind === 'oneshot' || raw.kind === 'cron') {
    return raw as unknown as CronJob
  }
  return { ...(raw as object), kind: 'cron' } as CronJob
}

export function createJsonJobStore(filepath: string): JobStore {
  async function load(): Promise<CronJob[]> {
    let raw: string
    try {
      raw = await readFile(filepath, 'utf-8')
    }
    catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return []
      }
      throw err
    }

    try {
      const parsed = JSON.parse(raw) as Array<Record<string, unknown>>
      return parsed.map(migrateLegacyJob)
    }
    catch (err: unknown) {
      const backupPath = `${filepath}.corrupt-${Date.now()}`
      console.warn(
        `[cron-runtime] Corrupt jobs file at ${filepath} — backing up to ${backupPath}. Error: ${errorMessageFrom(err)}`,
      )
      // Best-effort backup; on rename failure we still return empty.
      try {
        await rename(filepath, backupPath)
      }
      catch {}
      return []
    }
  }

  async function save(jobs: CronJob[]): Promise<void> {
    await mkdir(dirname(filepath), { recursive: true })
    // NOTICE: write-then-rename keeps the target file atomic against power-loss
    // or process crashes. A direct writeFile(filepath, …) can be observed
    // half-written by a subsequent load(), which would surface as corrupt JSON
    // and trigger the .corrupt-<ts> backup path — eating the user's jobs on
    // every unclean shutdown. Rename is atomic on POSIX within the same
    // directory, so load() either sees the pre-save snapshot or the full new
    // payload, never a partial write.
    const tmpPath = `${filepath}.tmp`
    try {
      await writeFile(tmpPath, JSON.stringify(jobs, null, 2), 'utf-8')
      await rename(tmpPath, filepath)
    }
    catch (err) {
      // Best-effort cleanup so a failed save does not leak a stale tmp file
      // that confuses later saves or operators. Swallow ENOENT because the
      // tmp may never have been created.
      try {
        await unlink(tmpPath)
      }
      catch {}
      throw err
    }
  }

  return { load, save }
}
