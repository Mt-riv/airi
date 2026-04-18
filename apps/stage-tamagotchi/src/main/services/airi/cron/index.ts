import type { Clock, CronScheduler, CronTriggerEvent } from '@proj-airi/cron-runtime'

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { createCronScheduler, createJsonJobStore, SystemClock } from '@proj-airi/cron-runtime'

import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'

export function setupCronManager(options?: {
  jobStorePath?: string
  clock?: Clock
  onTrigger?: (event: CronTriggerEvent) => void
}): CronScheduler {
  const jobStorePath = options?.jobStorePath ?? join(homedir(), '.airi', 'cron', 'jobs.json')
  const parentDir = dirname(jobStorePath)

  // Ensure the parent directory exists; fire-and-forget since the scheduler
  // will fail with a useful error when it actually tries to write.
  mkdir(parentDir, { recursive: true }).catch(() => {})

  const store = createJsonJobStore(jobStorePath)
  const clock = options?.clock ?? SystemClock
  const onTrigger = options?.onTrigger ?? (() => {})

  const scheduler = createCronScheduler({ store, clock, onTrigger })

  onAppBeforeQuit(async () => {
    await scheduler.stop()
  })

  // NOTICE: `scheduler.start()` is intentionally NOT called here. The caller
  // (agent manager) decides when to start based on the feature flag state. This
  // avoids scheduling cron jobs when agentRuntime.enabled is false.
  return scheduler
}
