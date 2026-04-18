import { boolean, object, optional, picklist, string } from 'valibot'

import { createConfig } from '../libs/electron/persistence'

export const globalAppConfigSchema = object({
  language: optional(string(), 'en'),
  updateChannel: optional(picklist(['stable', 'alpha', 'beta', 'nightly', 'canary'])),
  agentRuntime: optional(object({
    enabled: optional(boolean(), false),
  }), { enabled: false }),
})

export function createGlobalAppConfig() {
  const config = createConfig('app', 'options.json', globalAppConfigSchema)
  config.setup()

  return config
}
