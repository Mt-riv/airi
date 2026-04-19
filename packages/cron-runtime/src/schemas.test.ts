import { safeParse } from 'valibot'
import { describe, expect, it } from 'vitest'

import { cronJobInputSchema } from './schemas'

const validCronJob = {
  id: 'test-1',
  name: 'Test Job',
  kind: 'cron' as const,
  cron: '*/5 * * * *',
  prompt: 'Say hello',
  enabled: true,
}

const validOneshotJob = {
  id: 'timer-1',
  name: 'Timer Job',
  kind: 'oneshot' as const,
  fireAt: '2099-01-01T00:00:00.000Z',
  prompt: 'Say hello',
  enabled: true,
}

describe('cronJobInputSchema', () => {
  describe('kind: cron', () => {
    it('accepts a valid minimal job', () => {
      const result = safeParse(cronJobInputSchema, validCronJob)
      expect(result.success).toBe(true)
    })

    it('accepts a valid full job with all optional fields', () => {
      const result = safeParse(cronJobInputSchema, {
        ...validCronJob,
        sessionId: 'sess-abc',
        skillId: 'greeting',
        timezone: 'America/New_York',
      })
      expect(result.success).toBe(true)
    })

    it('rejects an invalid cron expression', () => {
      const result = safeParse(cronJobInputSchema, {
        ...validCronJob,
        cron: 'not-a-cron',
      })
      expect(result.success).toBe(false)
    })

    it('rejects an empty prompt', () => {
      const result = safeParse(cronJobInputSchema, {
        ...validCronJob,
        prompt: '',
      })
      expect(result.success).toBe(false)
    })

    it('rejects an invalid timezone string', () => {
      const result = safeParse(cronJobInputSchema, {
        ...validCronJob,
        timezone: 'Not/AReal/Timezone',
      })
      expect(result.success).toBe(false)
    })

    it('accepts Asia/Tokyo timezone', () => {
      const result = safeParse(cronJobInputSchema, {
        ...validCronJob,
        timezone: 'Asia/Tokyo',
      })
      expect(result.success).toBe(true)
    })

    it('rejects missing required field (name)', () => {
      const { name: _name, ...withoutName } = validCronJob
      const result = safeParse(cronJobInputSchema, withoutName)
      expect(result.success).toBe(false)
    })

    it('rejects missing cron when kind=cron', () => {
      const { cron: _cron, ...withoutCron } = validCronJob
      const result = safeParse(cronJobInputSchema, withoutCron)
      expect(result.success).toBe(false)
    })
  })

  describe('kind: oneshot', () => {
    it('accepts a valid minimal oneshot job', () => {
      const result = safeParse(cronJobInputSchema, validOneshotJob)
      expect(result.success).toBe(true)
    })

    it('rejects missing fireAt when kind=oneshot', () => {
      const { fireAt: _fireAt, ...withoutFireAt } = validOneshotJob
      const result = safeParse(cronJobInputSchema, withoutFireAt)
      expect(result.success).toBe(false)
    })

    it('rejects invalid fireAt timestamp', () => {
      const result = safeParse(cronJobInputSchema, {
        ...validOneshotJob,
        fireAt: 'not-a-date',
      })
      expect(result.success).toBe(false)
    })

    it('rejects cron field when kind=oneshot', () => {
      const result = safeParse(cronJobInputSchema, {
        ...validOneshotJob,
        cron: '*/5 * * * *',
      })
      // valibot union picks the first matching variant; cron with kind=oneshot
      // doesn't match either strict variant (oneshot forbids cron via object's
      // default reject-unknown-keys, recurring requires kind='cron').
      expect(result.success).toBe(false)
    })
  })

  it('rejects missing kind discriminator', () => {
    const { kind: _kind, ...withoutKind } = validCronJob
    const result = safeParse(cronJobInputSchema, withoutKind)
    expect(result.success).toBe(false)
  })
})
