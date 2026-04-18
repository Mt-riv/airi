import type { SkillDefinition } from '@proj-airi/skill-registry'

import type { SkillsManager } from '../agent/types'

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createSkillRegistry, discoverSkills } from '@proj-airi/skill-registry'

export function setupSkillsManager(options?: { userSkillsDir?: string }): SkillsManager {
  const userSkillsDir = options?.userSkillsDir ?? join(homedir(), '.airi', 'skills')
  const registry = createSkillRegistry()
  let loaded: SkillDefinition[] = []

  const reload = async (): Promise<SkillDefinition[]> => {
    await mkdir(userSkillsDir, { recursive: true })
    const discovered = await discoverSkills([userSkillsDir])
    registry.clear()
    for (const skill of discovered) {
      registry.register(skill)
    }
    loaded = registry.list()
    return loaded
  }

  // Kick off an initial (silent) load so `list()` returns something on first call.
  // Errors are swallowed here — the directory may not exist yet on first run,
  // and `reload()` will create it on the next explicit call.
  reload().catch(() => {})

  return {
    list: () => loaded,
    reload,
  }
}
