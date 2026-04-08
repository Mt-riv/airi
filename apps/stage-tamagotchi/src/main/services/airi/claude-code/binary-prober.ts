import type {
  ClaudeCodeCheckBinaryInput,
  ClaudeCodeCheckBinaryResult,
} from './types'

import { spawn } from 'node:child_process'

// Short probe timeout so an unresponsive or hung binary cannot stall the
// settings page validator. Five seconds is generous for `claude --version`
// which completes in < 500ms on a warm cache.
const BINARY_PROBE_TIMEOUT_MS = 5000

export type BinaryProber = (input: ClaudeCodeCheckBinaryInput) => Promise<ClaudeCodeCheckBinaryResult>

/**
 * Default probe: spawn `<binaryPath> --version` through
 * `node:child_process.spawn` with `shell: false` and an array of args so the
 * caller cannot inject additional flags through `binaryPath`. Returns a
 * structured success / failure result instead of throwing so validators can
 * surface it directly to the renderer.
 */
export function createDefaultBinaryProber(): BinaryProber {
  return async ({ binaryPath }) => {
    if (binaryPath.length === 0) {
      return { ok: false, error: 'binaryPath is empty' }
    }

    if (binaryPath.includes('\u0000')) {
      return { ok: false, error: 'binaryPath contains a NUL byte' }
    }

    return new Promise<ClaudeCodeCheckBinaryResult>((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const finalise = (result: ClaudeCodeCheckBinaryResult) => {
        if (settled)
          return
        settled = true
        if (timer != null)
          clearTimeout(timer)
        resolve(result)
      }

      const child = spawn(binaryPath, ['--version'], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      timer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        }
        catch {
          // ignore — the child is already gone
        }
        finalise({
          ok: false,
          error: `probing ${binaryPath} --version timed out after ${BINARY_PROBE_TIMEOUT_MS}ms`,
        })
      }, BINARY_PROBE_TIMEOUT_MS)

      let stdout = ''
      let stderr = ''

      child.stdout?.setEncoding('utf-8')
      child.stderr?.setEncoding('utf-8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
      })

      child.once('error', (error) => {
        finalise({ ok: false, error: error.message })
      })

      child.once('exit', (code) => {
        if (code === 0) {
          const version = stdout.trim().length > 0 ? stdout.trim() : 'unknown'
          finalise({ ok: true, version, path: binaryPath })
          return
        }

        const message = stderr.trim().length > 0
          ? stderr.trim()
          : `claude --version exited with code ${code ?? 'null'}`
        finalise({ ok: false, error: message })
      })
    })
  }
}
