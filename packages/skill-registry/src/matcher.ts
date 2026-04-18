import type { SkillDefinition, SkillMatcher } from './types'

import { errorMessageFrom } from '@moeru/std'

export function compileTriggers(triggers: string[]): RegExp[] {
  return triggers.map((pattern, index) => {
    try {
      return new RegExp(pattern, 'i')
    }
    catch (err) {
      throw new Error(`Invalid trigger regex at index ${index}: "${pattern}" — ${errorMessageFrom(err)}`)
    }
  })
}

// NOTICE: Per-skill regex cache. Triggers are immutable after a skill is
// loaded, so compiling once and reusing across every resolve() is safe and
// avoids O(triggers) RegExp construction on every prompt.
const compiledCache = new WeakMap<SkillDefinition, RegExp[]>()

function getCompiled(skill: SkillDefinition): RegExp[] {
  let regexes = compiledCache.get(skill)
  if (regexes === undefined) {
    regexes = compileTriggers(skill.triggers)
    compiledCache.set(skill, regexes)
  }
  return regexes
}

export function matchPrompt(prompt: string, skill: SkillDefinition): SkillMatcher {
  if (skill.triggers.length === 0) {
    return { matched: false, score: 0 }
  }

  const regexes = getCompiled(skill)
  let score = 0

  for (const re of regexes) {
    if (re.test(prompt)) {
      score++
    }
  }

  return { matched: score > 0, score }
}
