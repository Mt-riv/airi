import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { discoverSkills } from './workspace-discovery'

function makeSkillMd(id: string, name: string): string {
  return `---
id: ${id}
name: ${name}
description: Auto-generated skill for test
triggers:
  - "${id}"
---

Body of ${name}.
`
}

describe('discoverSkills', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'skill-discovery-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('discovers skills from two roots and unions them', async () => {
    const root1 = join(tmpDir, 'root1')
    const root2 = join(tmpDir, 'root2')
    await mkdir(root1)
    await mkdir(root2)

    const skill1Dir = join(root1, 'skill-alpha')
    await mkdir(skill1Dir)
    await writeFile(join(skill1Dir, 'SKILL.md'), makeSkillMd('skill-alpha', 'Skill Alpha'))

    const skill2Dir = join(root2, 'skill-beta')
    await mkdir(skill2Dir)
    await writeFile(join(skill2Dir, 'SKILL.md'), makeSkillMd('skill-beta', 'Skill Beta'))

    const skills = await discoverSkills([root1, root2])
    expect(skills).toHaveLength(2)
    const ids = skills.map(s => s.id)
    expect(ids).toContain('skill-alpha')
    expect(ids).toContain('skill-beta')
  })

  it('silently skips a missing root directory', async () => {
    const missingRoot = join(tmpDir, 'does-not-exist')

    const root = join(tmpDir, 'real-root')
    await mkdir(root)
    const skillDir = join(root, 'skill-a')
    await mkdir(skillDir)
    await writeFile(join(skillDir, 'SKILL.md'), makeSkillMd('skill-a', 'Skill A'))

    const skills = await discoverSkills([missingRoot, root])
    expect(skills).toHaveLength(1)
    expect(skills[0].id).toBe('skill-a')
  })

  it('warns and skips sub-directories without a SKILL.md', async () => {
    const root = join(tmpDir, 'root')
    await mkdir(root)

    const emptyDir = join(root, 'no-skill-here')
    await mkdir(emptyDir)

    const skillDir = join(root, 'valid-skill')
    await mkdir(skillDir)
    await writeFile(join(skillDir, 'SKILL.md'), makeSkillMd('valid-skill', 'Valid Skill'))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const skills = await discoverSkills([root])

    expect(skills).toHaveLength(1)
    expect(skills[0].id).toBe('valid-skill')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no-skill-here'))

    warnSpy.mockRestore()
  })

  it('deduplicates by id — first root wins when same id appears in multiple roots', async () => {
    const root1 = join(tmpDir, 'root1')
    const root2 = join(tmpDir, 'root2')
    await mkdir(root1)
    await mkdir(root2)

    const dir1 = join(root1, 'shared-skill')
    await mkdir(dir1)
    await writeFile(join(dir1, 'SKILL.md'), makeSkillMd('shared-skill', 'From Root 1'))

    const dir2 = join(root2, 'shared-skill')
    await mkdir(dir2)
    await writeFile(join(dir2, 'SKILL.md'), makeSkillMd('shared-skill', 'From Root 2'))

    const skills = await discoverSkills([root1, root2])
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('From Root 1')
  })
})
