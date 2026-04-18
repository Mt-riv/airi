import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadSkillFromDirectory } from './load-skill'

const VALID_SKILL_MD = `---
id: web-search
name: Web Search
description: Search the web and summarize results
triggers:
  - "search\\\\s+(for|about)"
  - "what is"
tools:
  - name: fetch
  - name: read
allowed:
  networks:
    - "https://api.example.com/*"
---

# Web Search Skill

This skill activates when the user asks to search the web.
`

describe('loadSkillFromDirectory', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'skill-registry-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('loads a valid SKILL.md and returns a SkillDefinition', async () => {
    const skillDir = join(tmpDir, 'web-search')
    await mkdir(skillDir)
    await writeFile(join(skillDir, 'SKILL.md'), VALID_SKILL_MD)

    const skill = await loadSkillFromDirectory(skillDir)

    expect(skill.id).toBe('web-search')
    expect(skill.name).toBe('Web Search')
    expect(skill.triggers).toHaveLength(2)
    expect(skill.tools).toHaveLength(2)
    expect(skill.allowed.networks).toContain('https://api.example.com/*')
    expect(skill.body).toContain('# Web Search Skill')
    expect(skill.sourceDir).toBe(skillDir)
  })

  it('throws when SKILL.md does not exist', async () => {
    const skillDir = join(tmpDir, 'no-skill')
    await mkdir(skillDir)

    await expect(loadSkillFromDirectory(skillDir)).rejects.toThrow(/Cannot read/)
  })

  it('throws when frontmatter is missing (plain Markdown with no --- delimiters)', async () => {
    const skillDir = join(tmpDir, 'no-frontmatter')
    await mkdir(skillDir)
    await writeFile(join(skillDir, 'SKILL.md'), '# Plain markdown\n\nNo frontmatter here.')

    await expect(loadSkillFromDirectory(skillDir)).rejects.toThrow(/Missing frontmatter/)
  })

  it('throws when frontmatter is missing required id field', async () => {
    const skillDir = join(tmpDir, 'missing-id')
    await mkdir(skillDir)
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: No ID Skill
description: This skill has no id
triggers: []
---

Body here.
`)
    await expect(loadSkillFromDirectory(skillDir)).rejects.toThrow(/Invalid frontmatter/)
  })

  it('returns empty body string when SKILL.md has only frontmatter', async () => {
    const skillDir = join(tmpDir, 'empty-body')
    await mkdir(skillDir)
    await writeFile(join(skillDir, 'SKILL.md'), `---
id: empty-body-skill
name: Empty Body
description: No body
triggers: []
---
`)

    const skill = await loadSkillFromDirectory(skillDir)
    expect(skill.id).toBe('empty-body-skill')
    expect(skill.body).toBe('')
  })

  it('defaults tools to [] and allowed to {} when not specified in frontmatter', async () => {
    const skillDir = join(tmpDir, 'minimal')
    await mkdir(skillDir)
    await writeFile(join(skillDir, 'SKILL.md'), `---
id: minimal-skill
name: Minimal
description: A minimal skill
triggers:
  - hello
---

Body.
`)

    const skill = await loadSkillFromDirectory(skillDir)
    expect(skill.tools).toEqual([])
    expect(skill.allowed).toEqual({})
  })
})
