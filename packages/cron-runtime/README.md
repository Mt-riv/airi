# @proj-airi/cron-runtime

Cron-based scheduler for AIRI periodic agent tasks. Provides a single-timer reschedule engine, injectable clock for deterministic testing, and two `JobStore` implementations (in-memory and JSON-file-backed) — with **zero dependencies on Electron or Vue**.

## What it does

- **`createCronScheduler`** — factory that creates a `CronScheduler` wired to a `JobStore`, `Clock`, and `onTrigger` callback. Uses a single `setTimeout` rescheduled to the nearest upcoming job — no interval polling.
- **`createMemoryJobStore`** — Map-backed in-memory store; intended for tests or short-lived processes.
- **`createJsonJobStore`** — Atomic JSON-file-backed store; tolerates missing files (treats as empty) and corrupt JSON (warns, backs up, returns empty).
- **`createFakeClock`** — Test helper with `advance(ms)` that synchronously fires registered callbacks whose deadline has passed. Makes scheduler tests deterministic.
- **`SystemClock`** — Production clock backed by `Date.now()` and the real `setTimeout`.
- **`cronJobInputSchema`** — Valibot schema that validates `CronJob` fields including the cron expression via `cron-parser`.

## How to use

```ts
import { createCronScheduler, createJsonJobStore, SystemClock } from '@proj-airi/cron-runtime'

const scheduler = createCronScheduler({
  store: createJsonJobStore('~/.airi/cron/jobs.json'),
  clock: SystemClock,
  onTrigger: ({ job, firedAt, scheduledFor }) => {
    // dispatch job.prompt to the agent runtime
  },
})

await scheduler.start()

await scheduler.addJob({
  id: 'morning-greeting',
  name: 'Morning Greeting',
  cron: '0 8 * * *',
  prompt: 'Good morning! Please greet the user.',
  enabled: true,
})
```

## When to use

- As the scheduling backbone in the Electron main-process cron service to drive proactive Airi behaviors.
- In unit tests with `createFakeClock()` + `createMemoryJobStore()` for deterministic scheduling assertions.

## When NOT to use

- Do not import from Vue components directly — use the Pinia store (`useAgentRuntimeStore`) / service layer in `apps/stage-tamagotchi/src/main/services/airi/cron`.
- Do not use `createJsonJobStore` in renderer processes — file I/O belongs in the Electron main process.
- Do not use this for real-time sub-second scheduling; cron expressions are minute-resolution.
