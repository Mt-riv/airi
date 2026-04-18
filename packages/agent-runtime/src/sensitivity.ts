export interface AllowList {
  /** Network host patterns. Trailing `*` acts as a glob prefix. */
  networks?: string[]
  /** Filesystem path patterns for write operations. */
  filesystemWrites?: string[]
  /** Shell command prefix patterns. */
  shellCommands?: string[]
}

export interface SensitivityResult {
  requiresApproval: boolean
  reason?: string
}

type SensitiveCategory = 'network' | 'filesystem.write' | 'shell'

interface CategoryRule {
  category: SensitiveCategory
  /** Prefixes (sans trailing dot) that map a tool name into this category. */
  prefixes: readonly string[]
  /** Input fields inspected for allow-list matching. */
  inputFields: readonly string[]
  /** Which allow-list array gates this category. */
  pickAllowed: (allowed: AllowList) => readonly string[] | undefined
  reasonLabel: string
}

// NOTICE: Prefix entries are matched as exact tool names or `<prefix>.<subpath>`
// segments — never as loose substrings. This prevents `exec` from matching
// `executor.spawn` or similar unrelated tools.
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: 'network',
    prefixes: ['network'],
    inputFields: ['host', 'url', 'target', 'address'],
    pickAllowed: a => a.networks,
    reasonLabel: 'network',
  },
  {
    category: 'filesystem.write',
    prefixes: ['filesystem.write'],
    inputFields: ['path', 'file', 'destination', 'dest'],
    pickAllowed: a => a.filesystemWrites,
    reasonLabel: 'filesystem.write',
  },
  {
    category: 'shell',
    prefixes: ['exec', 'shell'],
    inputFields: ['command', 'cmd', 'args'],
    pickAllowed: a => a.shellCommands,
    reasonLabel: 'shell/exec',
  },
]

function matchesPrefix(toolName: string, prefix: string): boolean {
  return toolName === prefix || toolName.startsWith(`${prefix}.`)
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1))
  }
  return value === pattern
}

function findRule(toolName: string): CategoryRule | undefined {
  return CATEGORY_RULES.find(rule =>
    rule.prefixes.some(p => matchesPrefix(toolName, p)),
  )
}

function extractStringField(input: unknown, fields: readonly string[]): string | undefined {
  if (input === null || typeof input !== 'object') {
    return undefined
  }
  const obj = input as Record<string, unknown>
  for (const field of fields) {
    const val = obj[field]
    if (typeof val === 'string') {
      return val
    }
  }
  return undefined
}

export function evaluateSensitivity(
  toolName: string,
  input: unknown,
  allowed?: AllowList,
): SensitivityResult {
  const rule = findRule(toolName)

  if (rule === undefined) {
    return { requiresApproval: false }
  }

  const patterns = allowed ? rule.pickAllowed(allowed) : undefined
  if (patterns && patterns.length > 0) {
    const value = extractStringField(input, rule.inputFields)
    if (value !== undefined && patterns.some(p => matchesPattern(value, p))) {
      return { requiresApproval: false }
    }
  }

  return { requiresApproval: true, reason: `${rule.reasonLabel} tool '${toolName}' requires approval` }
}
