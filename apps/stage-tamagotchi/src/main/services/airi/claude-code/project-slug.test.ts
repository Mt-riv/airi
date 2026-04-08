import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { projectSlugFor, projectSlugForRealpath } from './project-slug'

describe('projectSlugForRealpath', () => {
  it('replaces slashes with hyphens and keeps leading slash as leading dash', () => {
    expect(projectSlugForRealpath('/Users/dev/airi')).toBe('-Users-dev-airi')
  })

  it('converts underscores to hyphens (verified against Claude Code 2.1.96)', () => {
    expect(projectSlugForRealpath('/Users/y_yamakawa/development/airi')).toBe(
      '-Users-y-yamakawa-development-airi',
    )
  })

  it('converts dots to hyphens', () => {
    expect(projectSlugForRealpath('/private/tmp/a.b/c.d')).toBe('-private-tmp-a-b-c-d')
  })

  it('handles mixed underscores, dots, and slashes in a single path', () => {
    expect(
      projectSlugForRealpath('/private/tmp/airi_slug_test/a.b_c/d.e'),
    ).toBe('-private-tmp-airi-slug-test-a-b-c-d-e')
  })

  it('leaves alphanumeric and hyphen characters untouched', () => {
    expect(projectSlugForRealpath('/Users/dev/project-sample-2025')).toBe(
      '-Users-dev-project-sample-2025',
    )
  })

  it('does not double-hyphenate consecutive separators', () => {
    // Even though Claude Code does a naive replace (so // → --), we collapse
    // repeated separators for robustness — paths with // are rare but real.
    expect(projectSlugForRealpath('/Users//dev/airi')).toBe('-Users-dev-airi')
  })

  it('strips trailing slash before conversion', () => {
    expect(projectSlugForRealpath('/Users/dev/airi/')).toBe('-Users-dev-airi')
  })

  it('throws on empty input', () => {
    expect(() => projectSlugForRealpath('')).toThrow(/empty/i)
  })

  it('throws on path containing a NUL byte (command-injection guard)', () => {
    expect(() => projectSlugForRealpath('/Users/dev\u0000/airi')).toThrow(/NUL/i)
  })
})

describe('projectSlugFor (with realpath resolution)', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'airi-slug-test-'))
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('resolves a symlink to its realpath before slugifying', async () => {
    const linkPath = join(tmpRoot, 'link')
    await symlink(tmpRoot, linkPath)

    const fromReal = await projectSlugFor(tmpRoot)
    const fromLink = await projectSlugFor(linkPath)

    // The symlink and target resolve to the same realpath (minus the 'link'
    // suffix), so their slugs must match once realpath is applied.
    expect(fromLink).toBe(fromReal)
  })

  it('throws a clear error for a non-existent directory', async () => {
    await expect(projectSlugFor(join(tmpRoot, 'does-not-exist'))).rejects.toThrow()
  })
})
