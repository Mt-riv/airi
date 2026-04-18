import type { SkillRegistry } from './registry'
import type { SkillDefinition } from './types'

import { beforeEach, describe, expect, it } from 'vitest'

import { createSkillRegistry } from './registry'

function makeSkill(id: string, triggers: string[] = []): SkillDefinition {
  return {
    id,
    name: `Skill ${id}`,
    description: `Description for ${id}`,
    triggers,
    tools: [],
    allowed: {},
    body: '',
    sourceDir: `/tmp/${id}`,
  }
}

describe('createSkillRegistry', () => {
  let registry: SkillRegistry

  beforeEach(() => {
    registry = createSkillRegistry()
  })

  it('registers a skill and returns it via list()', () => {
    const skill = makeSkill('web-search', ['search for'])
    registry.register(skill)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].id).toBe('web-search')
  })

  it('throws when registering a skill with a duplicate id', () => {
    registry.register(makeSkill('dup-skill'))
    expect(() => registry.register(makeSkill('dup-skill'))).toThrow(/already registered/)
  })

  it('resolve returns matching skills sorted by score DESC', () => {
    // first-skill matches 1 trigger; second-skill matches 2 triggers.
    registry.register(makeSkill('first-skill', ['search']))
    registry.register(makeSkill('second-skill', ['search', 'web']))

    const results = registry.resolve('search the web')
    expect(results[0].id).toBe('second-skill')
    expect(results[1].id).toBe('first-skill')
  })

  it('resolve returns empty array when no skills match', () => {
    registry.register(makeSkill('noop', ['very-specific-trigger-xyz']))
    expect(registry.resolve('hello world')).toEqual([])
  })

  it('clear() removes all registered skills', () => {
    registry.register(makeSkill('to-clear'))
    registry.clear()
    expect(registry.list()).toHaveLength(0)
  })

  it('resolve preserves registration order as tiebreaker for equal scores', () => {
    // Both skills match 1 trigger each. Registration order should determine output order.
    registry.register(makeSkill('alpha', ['match']))
    registry.register(makeSkill('beta', ['match']))

    const results = registry.resolve('match this prompt')
    expect(results[0].id).toBe('alpha')
    expect(results[1].id).toBe('beta')
  })
})
