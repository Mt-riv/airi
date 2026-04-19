import type { AgentRuntimeCronJob, AgentRuntimeCronJobInput } from './agent-runtime'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agentRuntimeBuiltinTools,
  createBuiltinToolInvoker,
  MAX_ONESHOT_DURATION_MS,
} from './agent-runtime'

function makeDeps(overrides: Partial<{
  listCronJobs: () => Promise<AgentRuntimeCronJob[] | null>
  addCronJob: (job: AgentRuntimeCronJobInput) => Promise<AgentRuntimeCronJob | null>
  removeCronJob: (id: string) => Promise<{ ok: boolean } | null>
}> = {}) {
  return {
    listCronJobs: overrides.listCronJobs ?? vi.fn(async () => [] as AgentRuntimeCronJob[]),
    addCronJob: overrides.addCronJob ?? vi.fn(async (job: AgentRuntimeCronJobInput) => ({ ...job } as AgentRuntimeCronJob)),
    removeCronJob: overrides.removeCronJob ?? vi.fn(async () => ({ ok: true })),
  }
}

const NOW = Date.UTC(2026, 3, 18, 12, 0, 0)
const ABORT = new AbortController().signal

describe('agentRuntimeBuiltinTools', () => {
  it('declares all four tool names', () => {
    const names = agentRuntimeBuiltinTools.map(t => t.name)
    expect(names).toEqual(['schedule_oneshot', 'schedule_cron', 'list_cron_jobs', 'remove_cron_job'])
  })
})

describe('createBuiltinToolInvoker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('schedule_oneshot', () => {
    it('creates a oneshot job with fireAt = now + durationMs', async () => {
      const deps = makeDeps()
      const invoker = createBuiltinToolInvoker(deps)

      const result = await invoker.invoke('call-1', 'schedule_oneshot', {
        durationMs: 3 * 60_000,
        prompt: 'remind me to stretch',
      }, ABORT)

      expect(deps.addCronJob).toHaveBeenCalledOnce()
      const arg = (deps.addCronJob as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentRuntimeCronJobInput
      expect(arg.kind).toBe('oneshot')
      if (arg.kind !== 'oneshot')
        throw new Error('expected oneshot')
      expect(arg.fireAt).toBe(new Date(NOW + 3 * 60_000).toISOString())
      expect(arg.prompt).toBe('remind me to stretch')
      expect(arg.enabled).toBe(true)
      expect(arg.id).toMatch(/^timer-/)

      expect(result).toMatchObject({ ok: true })
    })

    it('rejects durationMs below 1 second', async () => {
      const invoker = createBuiltinToolInvoker(makeDeps())
      await expect(invoker.invoke('c', 'schedule_oneshot', { durationMs: 500, prompt: 'x' }, ABORT))
        .rejects
        .toThrow(/durationMs/)
    })

    it('rejects durationMs above 30-day cap', async () => {
      const invoker = createBuiltinToolInvoker(makeDeps())
      await expect(invoker.invoke('c', 'schedule_oneshot', {
        durationMs: MAX_ONESHOT_DURATION_MS + 1,
        prompt: 'x',
      }, ABORT)).rejects.toThrow(/30 days|<=/)
    })

    it('rejects empty prompt', async () => {
      const invoker = createBuiltinToolInvoker(makeDeps())
      await expect(invoker.invoke('c', 'schedule_oneshot', {
        durationMs: 60_000,
        prompt: '   ',
      }, ABORT)).rejects.toThrow(/prompt/)
    })

    it('generates a default name when none given', async () => {
      const deps = makeDeps()
      const invoker = createBuiltinToolInvoker(deps)
      await invoker.invoke('c', 'schedule_oneshot', {
        durationMs: 180_000,
        prompt: 'x',
      }, ABORT)
      const arg = (deps.addCronJob as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentRuntimeCronJobInput
      expect(arg.name).toBe('Timer +180s')
    })
  })

  describe('schedule_cron', () => {
    it('creates a recurring cron job', async () => {
      const deps = makeDeps()
      const invoker = createBuiltinToolInvoker(deps)

      await invoker.invoke('call-1', 'schedule_cron', {
        cron: '0 9 * * *',
        prompt: 'morning summary',
        name: 'Daily briefing',
        timezone: 'Asia/Tokyo',
      }, ABORT)

      expect(deps.addCronJob).toHaveBeenCalledOnce()
      const arg = (deps.addCronJob as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentRuntimeCronJobInput
      expect(arg.kind).toBe('cron')
      if (arg.kind !== 'cron')
        throw new Error('expected cron')
      expect(arg.cron).toBe('0 9 * * *')
      expect(arg.name).toBe('Daily briefing')
      expect(arg.timezone).toBe('Asia/Tokyo')
      expect(arg.id).toMatch(/^cron-/)
    })

    it('rejects missing cron', async () => {
      const invoker = createBuiltinToolInvoker(makeDeps())
      await expect(invoker.invoke('c', 'schedule_cron', {
        prompt: 'x',
        name: 'n',
      }, ABORT)).rejects.toThrow(/cron/)
    })
  })

  describe('list_cron_jobs', () => {
    it('returns jobs from deps', async () => {
      const jobs: AgentRuntimeCronJob[] = [
        { id: 'a', name: 'A', kind: 'cron', cron: '*/5 * * * *', prompt: 'p', enabled: true },
      ]
      const invoker = createBuiltinToolInvoker(makeDeps({ listCronJobs: async () => jobs }))
      const res = await invoker.invoke('c', 'list_cron_jobs', {}, ABORT) as { jobs: AgentRuntimeCronJob[] }
      expect(res.jobs).toEqual(jobs)
    })

    it('returns empty list when deps return null', async () => {
      const invoker = createBuiltinToolInvoker(makeDeps({ listCronJobs: async () => null }))
      const res = await invoker.invoke('c', 'list_cron_jobs', {}, ABORT) as { jobs: AgentRuntimeCronJob[] }
      expect(res.jobs).toEqual([])
    })
  })

  describe('remove_cron_job', () => {
    it('calls deps.removeCronJob with the id', async () => {
      const remove = vi.fn(async () => ({ ok: true }))
      const invoker = createBuiltinToolInvoker(makeDeps({ removeCronJob: remove }))
      const res = await invoker.invoke('c', 'remove_cron_job', { id: 'job-x' }, ABORT)
      expect(remove).toHaveBeenCalledWith('job-x')
      expect(res).toEqual({ ok: true })
    })

    it('rejects missing id', async () => {
      const invoker = createBuiltinToolInvoker(makeDeps())
      await expect(invoker.invoke('c', 'remove_cron_job', {}, ABORT)).rejects.toThrow(/id/)
    })
  })

  it('throws on unknown tool name', async () => {
    const invoker = createBuiltinToolInvoker(makeDeps())
    await expect(invoker.invoke('c', 'not-a-tool', {}, ABORT)).rejects.toThrow(/Unknown built-in tool/)
  })
})
