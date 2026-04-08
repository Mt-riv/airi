#!/usr/bin/env node
// Phase 0 POC: tail a Claude Code session JSONL file and pretty-print each
// event so we can confirm the schema documented in
// docs/integrations/claude-code-jsonl-schema.md without any project dependencies.
//
// Usage:
//   node scripts/poc/claude-code-tail.mjs                      # newest session in cwd's slug
//   node scripts/poc/claude-code-tail.mjs <session-uuid>       # specific session
//   node scripts/poc/claude-code-tail.mjs --project <dir>      # override cwd
//   node scripts/poc/claude-code-tail.mjs --once                # dump & exit (no tail)
//
// Designed to be discarded once Phase 1 ships the TypeScript session-watcher.

import { promises as fs, watch } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

// NOTICE: slug convention verified in Phase 0 — realpath first, then replace
//         `/`, `_`, and `.` with `-`. Examples:
//           /Users/y_yamakawa/development/airi
//             → -Users-y-yamakawa-development-airi
//           /tmp (symlink → /private/tmp)
//             → -private-tmp
//           /private/tmp/airi_slug_test/a.b_c/d.e
//             → -private-tmp-airi-slug-test-a-b-c-d-e
//         The transform is lossy (hyphens in the source directory and
//         slashes both collapse to `-`), so callers should treat the slug
//         strictly as a directory locator — never as a canonical identifier.
//         Source of truth: docs/integrations/claude-code-jsonl-schema.md §1.
async function projectSlugFor(dir) {
  const real = await fs.realpath(dir)
  return real.replace(/[/._]/g, '-')
}

function parseArgs(argv) {
  const args = { sessionId: null, projectDir: process.cwd(), once: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--project' || value === '-C') {
      args.projectDir = argv[i + 1]
      i += 1
    }
    else if (value === '--once') {
      args.once = true
    }
    else if (!value.startsWith('--') && !args.sessionId) {
      args.sessionId = value
    }
  }
  return args
}

async function newestSessionFile(slugDir) {
  const entries = await fs.readdir(slugDir, { withFileTypes: true })
  const files = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl'))
  if (files.length === 0) {
    throw new Error(`No .jsonl files in ${slugDir}`)
  }
  const stats = await Promise.all(
    files.map(async (f) => {
      const p = path.join(slugDir, f.name)
      const stat = await fs.stat(p)
      return { path: p, mtime: stat.mtimeMs }
    }),
  )
  stats.sort((a, b) => b.mtime - a.mtime)
  return stats[0].path
}

function formatEvent(line) {
  let event
  try {
    event = JSON.parse(line)
  }
  catch (error) {
    return `  [parse-error] ${error.message}\n  raw: ${line.slice(0, 200)}`
  }

  const base = `[${event.type ?? 'unknown'}${event.subtype ? `:${event.subtype}` : ''}]`
  const ts = event.timestamp ?? ''

  if (event.type === 'user' && event.message) {
    const { role, content } = event.message
    if (typeof content === 'string') {
      return `${base} ${role} "${truncate(content)}"`
    }
    if (Array.isArray(content)) {
      const parts = content.map((block) => {
        if (block.type === 'tool_result') {
          const result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          return `tool_result(${block.tool_use_id?.slice(0, 12) ?? '?'}, is_error=${block.is_error}) "${truncate(result)}"`
        }
        return block.type
      })
      return `${base} ${role} ${parts.join(' | ')}`
    }
    return `${base} user (attachment=${event.attachment?.type ?? '?'})`
  }

  if (event.type === 'assistant' && event.message?.content) {
    const blocks = event.message.content.map((block) => {
      if (block.type === 'text')
        return `text "${truncate(block.text)}"`
      if (block.type === 'thinking')
        return `thinking "${truncate(block.thinking)}"`
      if (block.type === 'tool_use')
        return `tool_use(${block.id?.slice(0, 12) ?? '?'}, ${block.name})`
      return block.type
    })
    const stop = event.message.stop_reason ? ` stop=${event.message.stop_reason}` : ''
    return `${base} ${event.message.model ?? 'model'}${stop} :: ${blocks.join(' | ')}`
  }

  if (event.type === 'system') {
    const extras = []
    if (event.subtype === 'turn_duration' && typeof event.durationMs === 'number')
      extras.push(`${event.durationMs}ms`)
    if (event.subtype === 'local_command' && event.content)
      extras.push(`"${truncate(event.content)}"`)
    if (event.subtype === 'api_error' && event.error)
      extras.push(`status=${event.error.status ?? '?'}`)
    return `${base} ${extras.join(' ')}`.trim()
  }

  if (event.type === 'file-history-snapshot') {
    const tracked = Object.keys(event.snapshot?.trackedFileBackups ?? {})
    return `${base} tracked=${tracked.length}`
  }

  // Unknown / metadata event — show a one-liner preview.
  const preview = truncate(JSON.stringify(event))
  return `${base} ${preview} ${ts ? `@ ${ts}` : ''}`.trim()
}

function truncate(value, limit = 120) {
  const normalized = String(value).replace(/\s+/g, ' ')
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

async function dumpAllLines(filePath, from = 0) {
  const handle = await fs.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= from)
      return { next: size }
    const buffer = Buffer.alloc(size - from)
    await handle.read(buffer, 0, buffer.length, from)
    const text = buffer.toString('utf8')
    const lines = text.split('\n').filter(line => line.length > 0)
    for (const line of lines)
      process.stdout.write(`${formatEvent(line)}\n`)
    return { next: size }
  }
  finally {
    await handle.close()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const slug = await projectSlugFor(args.projectDir)
  const slugDir = path.join(homedir(), '.claude', 'projects', slug)

  let filePath
  if (args.sessionId) {
    filePath = path.join(slugDir, `${args.sessionId}.jsonl`)
  }
  else {
    filePath = await newestSessionFile(slugDir)
  }

  process.stderr.write(`→ slug:    ${slug}\n`)
  process.stderr.write(`→ file:    ${filePath}\n`)

  let { next: cursor } = await dumpAllLines(filePath, 0)

  if (args.once)
    return

  process.stderr.write(`→ tailing (Ctrl+C to exit)…\n`)

  // NOTICE: Production Airi uses chokidar for cross-platform reliability.
  //         For this POC we use node:fs.watch because it requires no deps.
  const watcher = watch(filePath, { persistent: true })
  let pending = false
  watcher.on('change', async () => {
    if (pending)
      return
    pending = true
    try {
      const result = await dumpAllLines(filePath, cursor)
      cursor = result.next
    }
    catch (error) {
      process.stderr.write(`! read error: ${error.message}\n`)
    }
    finally {
      pending = false
    }
  })

  process.on('SIGINT', () => {
    watcher.close()
    process.exit(0)
  })
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error.stack ?? error.message}\n`)
  process.exit(1)
})
