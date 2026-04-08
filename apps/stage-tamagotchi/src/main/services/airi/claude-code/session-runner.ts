import type { ChildProcess } from 'node:child_process'

import type { NormalizedClaudeCodeEvent } from './types'

import { spawn } from 'node:child_process'

import { normalizeClaudeCodeLine } from './jsonl-to-stream-event'

export interface SessionRunnerOptions {
  binaryPath: string
  projectDir: string
  extraArgs?: readonly string[]
}

export interface SendPromptInput {
  text: string
  sessionId: string | null
}

export type SendPromptResult
  = | { ok: true, sessionId: string | null }
    | { ok: false, error: string, sessionId: string | null }

export type EventListener = (event: NormalizedClaudeCodeEvent) => void

export interface SessionRunner {
  sendPrompt: (input: SendPromptInput) => Promise<SendPromptResult>
  onEvent: (listener: EventListener) => () => void
  stop: () => Promise<void>
}

function assertSafeArgument(name: string, value: string): void {
  if (value.includes('\u0000')) {
    throw new Error(`${name} contains a NUL byte and cannot be passed to claude`)
  }
}

function extractSessionIdFromInit(event: NormalizedClaudeCodeEvent): string | null {
  if (event.kind !== 'meta')
    return null
  const raw = event.raw as { type?: unknown, subtype?: unknown, session_id?: unknown } | undefined
  if (!raw || raw.type !== 'system' || raw.subtype !== 'init')
    return null
  return typeof raw.session_id === 'string' ? raw.session_id : null
}

/**
 * Headless runner for `claude -p`. Spawns the CLI with a safe argument array
 * (never a shell string), streams stdout through our JSONL normaliser, and
 * resolves once the process exits with a structured result.
 *
 * The runner is single-session: one spawned process at a time. Phase 2 will
 * lift the serialisation up into the Eventa IPC handler.
 */
export function createSessionRunner(options: SessionRunnerOptions): SessionRunner {
  const { binaryPath, projectDir, extraArgs = [] } = options

  const listeners = new Set<EventListener>()
  let currentChild: ChildProcess | null = null

  const emit = (event: NormalizedClaudeCodeEvent) => {
    for (const listener of listeners) {
      try {
        listener(event)
      }
      catch {
        // NOTICE: Swallow listener errors to keep the stream flowing. We do
        //         not surface them — the runner's job is to forward events.
      }
    }
  }

  const sendPrompt = async (input: SendPromptInput): Promise<SendPromptResult> => {
    assertSafeArgument('prompt text', input.text)
    if (input.sessionId != null)
      assertSafeArgument('session id', input.sessionId)
    assertSafeArgument('projectDir', projectDir)
    assertSafeArgument('binaryPath', binaryPath)

    const args: string[] = ['-p', input.text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if (input.sessionId != null) {
      args.push('--resume', input.sessionId)
    }
    args.push(...extraArgs)

    const child = spawn(binaryPath, args, {
      cwd: projectDir,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    currentChild = child

    let pendingFragment = ''
    let capturedSessionId: string | null = input.sessionId
    let stderrBuffer = ''

    const processChunk = (chunk: string) => {
      const combined = pendingFragment + chunk
      const newlineIndex = combined.lastIndexOf('\n')
      if (newlineIndex === -1) {
        pendingFragment = combined
        return
      }

      const complete = combined.slice(0, newlineIndex)
      pendingFragment = combined.slice(newlineIndex + 1)

      for (const rawLine of complete.split('\n')) {
        if (rawLine.length === 0)
          continue
        const events = normalizeClaudeCodeLine(rawLine)
        for (const event of events) {
          if (capturedSessionId == null) {
            const initSessionId = extractSessionIdFromInit(event)
            if (initSessionId != null)
              capturedSessionId = initSessionId
          }
          emit(event)
        }
      }
    }

    if (child.stdout) {
      child.stdout.setEncoding('utf-8')
      child.stdout.on('data', (chunk: string) => processChunk(chunk))
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf-8')
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk
      })
    }

    return new Promise<SendPromptResult>((resolve) => {
      const finalise = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (pendingFragment.length > 0) {
          // Best-effort parse of whatever the process left behind.
          const events = normalizeClaudeCodeLine(pendingFragment)
          pendingFragment = ''
          for (const event of events) {
            if (capturedSessionId == null) {
              const initSessionId = extractSessionIdFromInit(event)
              if (initSessionId != null)
                capturedSessionId = initSessionId
            }
            emit(event)
          }
        }

        currentChild = null

        if (exitCode == null || exitCode === 0) {
          resolve({ ok: true, sessionId: capturedSessionId })
          return
        }

        const errorMessage = stderrBuffer.trim().length > 0
          ? stderrBuffer.trim()
          : `claude exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`
        resolve({ ok: false, error: errorMessage, sessionId: capturedSessionId })
      }

      child.once('error', (error) => {
        currentChild = null
        resolve({ ok: false, error: error.message, sessionId: capturedSessionId })
      })

      child.once('exit', (code, signal) => {
        finalise(code, signal)
      })
    })
  }

  const onEvent = (listener: EventListener): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const stop = async () => {
    if (currentChild) {
      try {
        currentChild.kill('SIGTERM')
      }
      catch {
        // ignore — already exited
      }
    }
  }

  return { sendPrompt, onEvent, stop }
}
