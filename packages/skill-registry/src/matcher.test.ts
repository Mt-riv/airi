import type { SkillDefinition } from './types'

import { describe, expect, it } from 'vitest'

import { compileTriggers, matchPrompt } from './matcher'

function makeSkill(triggers: string[]): SkillDefinition {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    triggers,
    tools: [],
    allowed: {},
    body: '',
    sourceDir: '/tmp/test-skill',
  }
}

describe('compileTriggers', () => {
  it('compiles valid trigger patterns without throwing', () => {
    const regexes = compileTriggers(['search\\s+for', 'what is'])
    expect(regexes).toHaveLength(2)
    expect(regexes[0]).toBeInstanceOf(RegExp)
  })

  it('throws on invalid regex pattern', () => {
    expect(() => compileTriggers(['[invalid-regex'])).toThrow(/Invalid trigger regex/)
  })
})

describe('matchPrompt', () => {
  it('returns matched=true and score=1 for a single trigger hit', () => {
    const skill = makeSkill(['search\\s+for'])
    const result = matchPrompt('Please search for cats', skill)
    expect(result.matched).toBe(true)
    expect(result.score).toBe(1)
  })

  it('returns score equal to number of distinct trigger patterns that matched', () => {
    const skill = makeSkill(['search\\s+for', 'cats'])
    const result = matchPrompt('search for cats', skill)
    expect(result.matched).toBe(true)
    expect(result.score).toBe(2)
  })

  it('returns matched=false and score=0 when no triggers match', () => {
    const skill = makeSkill(['search\\s+for'])
    const result = matchPrompt('tell me a joke', skill)
    expect(result.matched).toBe(false)
    expect(result.score).toBe(0)
  })

  it('returns matched=false and score=0 for empty triggers list', () => {
    const skill = makeSkill([])
    const result = matchPrompt('search for anything', skill)
    expect(result.matched).toBe(false)
    expect(result.score).toBe(0)
  })

  it('matching is case-insensitive', () => {
    const skill = makeSkill(['SEARCH'])
    const result = matchPrompt('please search the web', skill)
    expect(result.matched).toBe(true)
  })

  it('counts each matching trigger pattern once even if prompt matches multiple times', () => {
    // One pattern matches twice in the string — score should still be 1 (distinct trigger count).
    const skill = makeSkill(['cat'])
    const result = matchPrompt('the cat sat on a cat mat', skill)
    expect(result.matched).toBe(true)
    expect(result.score).toBe(1)
  })
})
