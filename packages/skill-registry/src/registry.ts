import type { SkillDefinition } from './types'

import { matchPrompt } from './matcher'

export interface SkillRegistry {
  register: (skill: SkillDefinition) => void
  resolve: (prompt: string) => SkillDefinition[]
  list: () => SkillDefinition[]
  clear: () => void
}

export function createSkillRegistry(): SkillRegistry {
  const skills: SkillDefinition[] = []
  const ids = new Set<string>()

  function register(skill: SkillDefinition): void {
    if (ids.has(skill.id)) {
      throw new Error(`Skill with id "${skill.id}" is already registered`)
    }
    ids.add(skill.id)
    skills.push(skill)
  }

  function resolve(prompt: string): SkillDefinition[] {
    const scored = skills
      .map((skill, registrationOrder) => ({ skill, registrationOrder, ...matchPrompt(prompt, skill) }))
      .filter(entry => entry.matched)

    scored.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score
      }
      return a.registrationOrder - b.registrationOrder
    })

    return scored.map(entry => entry.skill)
  }

  function list(): SkillDefinition[] {
    return [...skills]
  }

  function clear(): void {
    skills.length = 0
    ids.clear()
  }

  return { register, resolve, list, clear }
}
