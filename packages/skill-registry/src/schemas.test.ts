import { parse, ValiError } from 'valibot'
import { describe, expect, it } from 'vitest'

import { skillManifestSchema } from './schemas'

describe('skillManifestSchema', () => {
  it('accepts a valid minimal manifest', () => {
    const result = parse(skillManifestSchema, {
      id: 'web-search',
      name: 'Web Search',
      description: 'Search the web',
      triggers: ['search for'],
    })
    expect(result.id).toBe('web-search')
    expect(result.tools).toBeUndefined()
    expect(result.allowed).toBeUndefined()
  })

  it('accepts a valid full manifest with tools and allowed', () => {
    const result = parse(skillManifestSchema, {
      id: 'file-ops',
      name: 'File Operations',
      description: 'Read and write files',
      triggers: ['read file', 'write file'],
      tools: [{ name: 'read' }, { name: 'write', description: 'Write to disk' }],
      allowed: {
        networks: ['https://api.example.com/*'],
        filesystemWrites: ['/tmp/*'],
      },
    })
    expect(result.tools).toHaveLength(2)
    expect(result.allowed?.networks).toContain('https://api.example.com/*')
  })

  it('rejects a manifest missing required id field', () => {
    expect(() =>
      parse(skillManifestSchema, {
        name: 'No ID Skill',
        description: 'Missing id',
        triggers: [],
      }),
    ).toThrow(ValiError)
  })

  it('rejects a manifest where triggers is not an array', () => {
    expect(() =>
      parse(skillManifestSchema, {
        id: 'bad-triggers',
        name: 'Bad',
        description: 'Triggers is a string not array',
        triggers: 'search for',
      }),
    ).toThrow(ValiError)
  })

  it('rejects a tools entry without a name field', () => {
    expect(() =>
      parse(skillManifestSchema, {
        id: 'bad-tools',
        name: 'Bad Tools',
        description: 'Tool entry missing name',
        triggers: [],
        tools: [{ description: 'no name here' }],
      }),
    ).toThrow(ValiError)
  })

  it('rejects a manifest missing required description', () => {
    expect(() =>
      parse(skillManifestSchema, {
        id: 'no-desc',
        name: 'No Description',
        triggers: [],
      }),
    ).toThrow(ValiError)
  })
})
