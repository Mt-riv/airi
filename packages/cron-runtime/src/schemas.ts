import { CronExpressionParser } from 'cron-parser'
import {
  boolean,
  check,
  object,
  optional,
  pipe,
  string,
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

export const cronJobInputSchema = object({
  id: string(),
  name: string(),
  cron: pipe(
    string(),
    check(isValidCronExpression, 'Invalid cron expression'),
  ),
  prompt: pipe(
    string(),
    check(v => v.length > 0, 'prompt must not be empty'),
  ),
  sessionId: optional(string()),
  enabled: boolean(),
  skillId: optional(string()),
  timezone: optional(
    pipe(
      string(),
      check((tz) => {
        try {
          // Validate timezone by attempting to use it in Intl
          Intl.DateTimeFormat(undefined, { timeZone: tz })
          return true
        }
        catch {
          return false
        }
      }, 'Invalid timezone'),
    ),
  ),
})
