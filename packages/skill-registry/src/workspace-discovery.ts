import type { SkillDefinition } from './types'

import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

import { loadSkillFromDirectory } from './load-skill'

export async function discoverSkills(roots: string[]): Promise<SkillDefinition[]> {
  const seenIds = new Set<string>()
  const result: SkillDefinition[] = []

  for (const root of roots) {
    let entryNames: string[]
    try {
      entryNames = await readdir(root)
    }
    catch {
      continue
    }

    for (const name of entryNames) {
      const subDir = resolve(root, name)

      try {
        const s = await stat(subDir)
        if (!s.isDirectory()) {
          continue
        }
      }
      catch {
        continue
      }

      let skill: SkillDefinition
      try {
        skill = await loadSkillFromDirectory(subDir)
      }
      catch (err) {
        // loadSkillFromDirectory throws ENOENT for missing SKILL.md; same path
        // as any other load failure (malformed YAML, invalid frontmatter, ...).
        console.warn(`[skill-registry] Skipping "${subDir}": ${errorMessageFrom(err)}`)
        continue
      }

      if (seenIds.has(skill.id)) {
        continue
      }

      seenIds.add(skill.id)
      result.push(skill)
    }
  }

  return result
}
