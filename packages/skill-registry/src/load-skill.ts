import type { SkillDefinition } from './types'

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import matter from 'gray-matter'

import { errorMessageFrom } from '@moeru/std'
import { parse, ValiError } from 'valibot'

import { skillManifestSchema } from './schemas'

export async function loadSkillFromDirectory(dir: string): Promise<SkillDefinition> {
  const filePath = join(dir, 'SKILL.md')

  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  }
  catch (err) {
    throw new Error(`Cannot read ${filePath}: ${errorMessageFrom(err)}`)
  }

  let parsed: ReturnType<typeof matter>
  try {
    parsed = matter(raw)
  }
  catch (err) {
    throw new Error(`Failed to parse frontmatter in ${filePath}: ${errorMessageFrom(err)}`)
  }

  if (parsed.data == null || typeof parsed.data !== 'object' || Object.keys(parsed.data).length === 0) {
    throw new Error(`Missing frontmatter in ${filePath}`)
  }

  let manifest: ReturnType<typeof parse<typeof skillManifestSchema>>
  try {
    manifest = parse(skillManifestSchema, parsed.data)
  }
  catch (err) {
    if (err instanceof ValiError) {
      const issues = err.issues.map(i => i.message).join(', ')
      throw new Error(`Invalid frontmatter in ${filePath}: ${issues}`)
    }
    throw new Error(`Frontmatter validation failed in ${filePath}: ${errorMessageFrom(err)}`)
  }

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    triggers: manifest.triggers,
    tools: manifest.tools ?? [],
    allowed: manifest.allowed ?? {},
    body: parsed.content.trim(),
    sourceDir: dir,
  }
}
