export interface ToolRef {
  name: string
  description?: string
}

export interface AllowListRef {
  networks?: string[]
  filesystemWrites?: string[]
  shellCommands?: string[]
}

/** Parsed and validated frontmatter block of a SKILL.md file. */
export interface SkillManifest {
  id: string
  name: string
  description: string
  triggers: string[]
  tools?: ToolRef[]
  allowed?: AllowListRef
}

/** Full skill definition: manifest metadata + extracted Markdown body. */
export interface SkillDefinition {
  id: string
  name: string
  description: string
  triggers: string[]
  tools: ToolRef[]
  allowed: AllowListRef
  /** Raw Markdown body extracted after the frontmatter block. */
  body: string
  /** Absolute path of the directory from which this skill was loaded. */
  sourceDir: string
}

export interface SkillMatcher {
  matched: boolean
  /** Number of distinct trigger patterns that matched the prompt. Used for ranking. */
  score: number
}
