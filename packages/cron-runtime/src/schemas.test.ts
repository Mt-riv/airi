import { safeParse } from 'valibot'
import { describe, expect, it } from 'vitest'

import { cronJobInputSchema } from './schemas'

const validBase = {
  id: 'test-1',
  name: 'Test Job',
  cron: '*/5 * * * *',
  prompt: 'Say hello',
  enabled: true,
}

describe('cronJobInputSchema', () => {
  it('accepts a valid minimal job', () => {
    const result = safeParse(cronJobInputSchema, validBase)
    expect(result.success).toBe(true)
  })

  it('accepts a valid full job with all optional fields', () => {
    const result = safeParse(cronJobInputSchema, {
      ...validBase,
      sessionId: 'sess-abc',
      skillId: 'greeting',
      timezone: 'America/New_York',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an invalid cron expression', () => {
    const result = safeParse(cronJobInputSchema, {
      ...validBase,
      cron: 'not-a-cron',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty prompt', () => {
    const result = safeParse(cronJobInputSchema, {
      ...validBase,
      prompt: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid timezone string', () => {
    const result = safeParse(cronJobInputSchema, {
      ...validBase,
      timezone: 'Not/AReal/Timezone',
    })
    expect(result.success).toBe(false)
  })

  it('accepts valid cron with multiple fields (hourly)', () => {
    const result = safeParse(cronJobInputSchema, {
      ...validBase,
      cron: '0 * * * *',
    })
    expect(result.success).toBe(true)
  })

  it('accepts Asia/Tokyo timezone', () => {
    const result = safeParse(cronJobInputSchema, {
      ...validBase,
      timezone: 'Asia/Tokyo',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing required field (name)', () => {
    const { name: _name, ...withoutName } = validBase
    const result = safeParse(cronJobInputSchema, withoutName)
    expect(result.success).toBe(false)
  })
})
