import { CronExpressionParser } from 'cron-parser'
import {
  boolean,
  check,
  literal,
  optional,
  pipe,
  strictObject,
  string,
  union,
} from 'valibot'

// NOTICE: cron-parser v5 parses 5-field (minute-resolution) and 6-field
// (second-resolution) expressions. We accept both here since CronExpressionParser
// throws for invalid syntax, which is the only validation we need at this layer.
function isValidCronExpression(value: string): boolean {
  try {
    CronExpressionParser.parse(value)
    return true
  }
  catch {
    return false
  }
}

function isValidIsoTimestamp(value: string): boolean {
  const t = Date.parse(value)
  return Number.isFinite(t)
}

const isoTimestamp = pipe(string(), check(isValidIsoTimestamp, 'Invalid ISO-8601 timestamp'))
const cronExpression = pipe(string(), check(isValidCronExpression, 'Invalid cron expression'))

const timezoneField = pipe(
  string(),
  check((tz) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz })
      return true
    }
    catch {
      return false
    }
  }, 'Invalid timezone'),
)

const baseFields = {
  id: string(),
  name: string(),
  prompt: pipe(string(), check(v => v.length > 0, 'prompt must not be empty')),
  sessionId: optional(string()),
  enabled: boolean(),
  skillId: optional(string()),
  timezone: optional(timezoneField),
}

const recurringSchema = strictObject({
  ...baseFields,
  kind: literal('cron'),
  cron: cronExpression,
})

const oneshotSchema = strictObject({
  ...baseFields,
  kind: literal('oneshot'),
  fireAt: isoTimestamp,
})

export const cronJobInputSchema = union([recurringSchema, oneshotSchema])
