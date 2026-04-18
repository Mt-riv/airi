// Public API — types, factories, loaders, and schemas only.

export { loadSkillFromDirectory } from './load-skill'
export { compileTriggers, matchPrompt } from './matcher'
export { createSkillRegistry } from './registry'
export type { SkillRegistry } from './registry'
export { skillManifestSchema } from './schemas'
export type {
  AllowListRef,
  SkillDefinition,
  SkillManifest,
  SkillMatcher,
  ToolRef,
} from './types'
export { discoverSkills } from './workspace-discovery'
