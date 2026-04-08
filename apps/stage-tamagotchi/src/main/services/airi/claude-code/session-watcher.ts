import type { FSWatcher } from 'node:fs'

import type { NormalizedClaudeCodeEvent } from './types'

import { Buffer } from 'node:buffer'
import { watch } from 'node:fs'
import { open } from 'node:fs/promises'

import { normalizeClaudeCodeLine } from './jsonl-to-stream-event'

export interface SessionWatcherOptions {
  filePath: string
  onEvent: (event: NormalizedClaudeCodeEvent) => void
  onError?: (error: Error) => void
}

export interface SessionWatcher {
  start: () => Promise<void>
  stop: () => Promise<void>
}

// NOTICE: We deliberately use `node:fs.watch` + a size-based cursor instead of
//         chokidar. Rationale:
//           1. Phase 0 POC proved the cursor model handles partial writes
//              correctly (we buffer the trailing incomplete line and replay
//              it once the newline lands).
//           2. Adding chokidar here would ship an extra dependency for a
//              single consumer. If cross-platform flakiness surfaces later we
//              can swap the implementation behind this factory without
//              touching callers.
//         The cursor strategy: remember byte offset, on each fs.watch
//         'change' event re-open the file (in case it was truncated or
//         rotated), read from the cursor to the new EOF, split on `\n`, hold
//         back any trailing fragment until the next change.
export function createSessionWatcher(options: SessionWatcherOptions): SessionWatcher {
  const { filePath, onEvent, onError } = options

  let cursor = 0
  let pendingFragment = ''
  let watcher: FSWatcher | null = null
  let draining = false
  let rerunAfterDrain = false
  let stopped = false

  const emitError = (error: unknown) => {
    const normalised = error instanceof Error ? error : new Error(String(error))
    onError?.(normalised)
  }

  const drain = async () => {
    if (stopped)
      return

    if (draining) {
      rerunAfterDrain = true
      return
    }
    draining = true

    try {
      const handle = await open(filePath, 'r')
      try {
        const stat = await handle.stat()
        if (stat.size < cursor) {
          // File was truncated or rotated — restart from the beginning.
          cursor = 0
          pendingFragment = ''
        }

        if (stat.size === cursor)
          return

        const length = stat.size - cursor
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, cursor)
        cursor = stat.size

        const chunk = pendingFragment + buffer.toString('utf-8')
        const newlineIndex = chunk.lastIndexOf('\n')

        if (newlineIndex === -1) {
          pendingFragment = chunk
          return
        }

        const complete = chunk.slice(0, newlineIndex)
        pendingFragment = chunk.slice(newlineIndex + 1)

        const lines = complete.split('\n')
        for (const line of lines) {
          if (stopped)
            return
          if (line.length === 0)
            continue

          const events = normalizeClaudeCodeLine(line)
          for (const event of events) {
            if (stopped)
              return
            try {
              onEvent(event)
            }
            catch (error) {
              emitError(error)
            }
          }
        }
      }
      finally {
        await handle.close()
      }
    }
    catch (error) {
      emitError(error)
    }
    finally {
      draining = false
      if (rerunAfterDrain && !stopped) {
        rerunAfterDrain = false
        // Re-run asynchronously to avoid unbounded recursion.
        void drain()
      }
    }
  }

  const start = async () => {
    if (stopped)
      return

    // Initial drain: read whatever is already in the file.
    await drain()

    if (stopped)
      return

    try {
      watcher = watch(filePath, { persistent: true })
      watcher.on('change', () => {
        void drain()
      })
      watcher.on('error', error => emitError(error))
    }
    catch (error) {
      emitError(error)
    }
  }

  const stop = async () => {
    stopped = true
    if (watcher) {
      try {
        watcher.close()
      }
      catch {
        // ignore
      }
      watcher = null
    }
  }

  return { start, stop }
}
