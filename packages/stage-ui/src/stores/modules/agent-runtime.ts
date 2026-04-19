import type {
  AgentEvent,
  AgentMessage,
  ApprovalDecision,
  ApprovalRequest,
  ModelDriver,
  PartialReply,
  StopReason,
  SystemRunPlan,
  ToolDefinition,
  ToolInvoker,
} from '@proj-airi/agent-runtime'
import type { ChatProvider } from '@xsai-ext/providers/utils'

import { defineEventa, defineInvoke, defineInvokeEventa } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { errorMessageFrom } from '@moeru/std'
import { createAgentHarness, createInteractiveApprovalGate } from '@proj-airi/agent-runtime'
import { defineStore } from 'pinia'
import { computed, onMounted, reactive, ref } from 'vue'

import { createXsaiModelDriver } from '../../libs/providers/agent-driver-bridge'
import { getMcpToolBridge } from '../mcp-tool-bridge'
import { useProvidersStore } from '../providers'
import { useConsciousnessStore } from './consciousness'

// Inline type definitions matching packages/cron-runtime/src/types.ts and
// packages/skill-registry/src/types.ts so stage-ui stays free of those deps.
export interface AgentRuntimeSkillDefinition {
  id: string
  name: string
  description: string
  triggers: string[]
  tools: Array<{ name: string, description?: string }>
  allowed: {
    networks?: string[]
    filesystemWrites?: string[]
    shellCommands?: string[]
  }
  body: string
  sourceDir: string
}

interface AgentRuntimeCronJobBase {
  id: string
  name: string
  prompt: string
  sessionId?: string
  enabled: boolean
  skillId?: string
  timezone?: string
  lastRunAt?: string
  nextRunAt?: string
}

export interface AgentRuntimeRecurringCronJob extends AgentRuntimeCronJobBase {
  kind: 'cron'
  cron: string
}

export interface AgentRuntimeOneshotCronJob extends AgentRuntimeCronJobBase {
  kind: 'oneshot'
  /** ISO-8601 timestamp of when this job should fire once. */
  fireAt: string
}

export type AgentRuntimeCronJob = AgentRuntimeRecurringCronJob | AgentRuntimeOneshotCronJob

export type AgentRuntimeCronJobInput
  = | Omit<AgentRuntimeRecurringCronJob, 'nextRunAt' | 'lastRunAt'>
    | Omit<AgentRuntimeOneshotCronJob, 'nextRunAt' | 'lastRunAt'>

export interface AgentRuntimeStatus {
  enabled: boolean
  skillsLoaded: number
  cronJobsEnabled: number
  activeTurns: number
}

export interface AgentRuntimeCronTriggered {
  jobId: string
  turnId: string
  prompt: string
  skillId?: string
}

export interface AgentTurnRecord {
  turnId: string
  jobId?: string
  startedAt: number
  finishedAt?: number
  stopReason?: StopReason
  text: string
  events: AgentEvent[]
  error?: string
}

export interface PendingApprovalRecord {
  id: string
  turnId: string
  plan: SystemRunPlan
  createdAt: number
}

const _agentRuntimeStatus = defineInvokeEventa<AgentRuntimeStatus>(
  'eventa:invoke:electron:agent-runtime:status',
)
const _agentRuntimeSetEnabled = defineInvokeEventa<AgentRuntimeStatus, { enabled: boolean }>(
  'eventa:invoke:electron:agent-runtime:set-enabled',
)
const _agentRuntimeReloadSkills = defineInvokeEventa<AgentRuntimeSkillDefinition[]>(
  'eventa:invoke:electron:agent-runtime:reload-skills',
)
const _agentRuntimeListCronJobs = defineInvokeEventa<AgentRuntimeCronJob[]>(
  'eventa:invoke:electron:agent-runtime:list-cron-jobs',
)
const _agentRuntimeAddCronJob = defineInvokeEventa<
  AgentRuntimeCronJob,
  AgentRuntimeCronJobInput
>(
  'eventa:invoke:electron:agent-runtime:add-cron-job',
)
const _agentRuntimeRemoveCronJob = defineInvokeEventa<{ ok: boolean }, { id: string }>(
  'eventa:invoke:electron:agent-runtime:remove-cron-job',
)
const _agentRuntimeToggleCronJob = defineInvokeEventa<
  AgentRuntimeCronJob,
  { id: string, enabled: boolean }
>(
  'eventa:invoke:electron:agent-runtime:toggle-cron-job',
)

// Event (not invoke) — main broadcasts cron triggers so the renderer runs
// the harness locally. Defined inline to avoid cross-package imports; the
// event-id string must stay in sync with the main-side broadcast.
const _agentRuntimeCronTriggered = defineEventa<AgentRuntimeCronTriggered>(
  'eventa:event:electron:agent-runtime:cron-triggered',
)

type IpcRendererLike = Parameters<typeof createContext>[0]

let _sharedCtx: ReturnType<typeof createContext>['context'] | null = null

function getContextOrNull() {
  if (_sharedCtx)
    return _sharedCtx
  const ipcRenderer = (globalThis as { window?: { electron?: { ipcRenderer?: IpcRendererLike } } })
    .window
    ?.electron
    ?.ipcRenderer
  if (!ipcRenderer)
    return null
  _sharedCtx = createContext(ipcRenderer).context
  return _sharedCtx
}

function safeInvoke<Res, Req>(eventa: ReturnType<typeof defineInvokeEventa<Res, Req>>) {
  return async (req?: Req): Promise<Res | null> => {
    const ctx = getContextOrNull()
    if (!ctx)
      return null
    return defineInvoke(ctx, eventa)(req as Req)
  }
}

function createMcpToolInvoker(): ToolInvoker {
  return {
    invoke: async (_callId, toolName, input, signal) => {
      if (signal.aborted) {
        const err = new Error('Tool call aborted')
        err.name = 'AbortError'
        throw err
      }
      const result = await getMcpToolBridge().callTool({
        name: toolName,
        arguments: (input ?? {}) as Record<string, unknown>,
      })
      if (result.structuredContent != null)
        return result.structuredContent
      if (result.toolResult != null)
        return result.toolResult
      return result.content
    },
    cancel: () => {
      // NOTICE: The MCP bridge does not expose per-call cancellation yet.
      // Abort is best-effort via signal checks inside invoke().
    },
  }
}

// Upper bound for oneshot timers — 30 days. Matches product decision so that
// users cannot accidentally register a multi-year reminder that outlives the
// app install.
export const MAX_ONESHOT_DURATION_MS = 30 * 24 * 60 * 60 * 1000

const BUILTIN_TOOL_NAMES = ['schedule_oneshot', 'schedule_cron', 'list_cron_jobs', 'remove_cron_job'] as const
type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number]

function isBuiltinToolName(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name)
}

export const agentRuntimeBuiltinTools: ToolDefinition[] = [
  {
    name: 'schedule_oneshot',
    description: 'Schedule a one-shot reminder that fires once after a specified delay. When it fires, the agent is re-invoked with the given prompt as a fresh user message. Use this for phrases like "tell me in 3 minutes", "remind me after 10 minutes", or "check back in 1 hour".',
    inputSchema: {
      type: 'object',
      properties: {
        durationMs: {
          type: 'number',
          description: `Delay from now in milliseconds. Must be between 1000 (1 second) and ${MAX_ONESHOT_DURATION_MS} (30 days).`,
        },
        prompt: {
          type: 'string',
          description: 'User-visible prompt that will be sent to the agent when the timer fires. Write it as if the user is asking the question at that future moment.',
        },
        name: {
          type: 'string',
          description: 'Optional short label for the timer shown in the UI.',
        },
      },
      required: ['durationMs', 'prompt'],
    },
  },
  {
    name: 'schedule_cron',
    description: 'Schedule a recurring cron job. Use this for phrases like "every day at 9 AM", "every hour", or "every Monday". The prompt is delivered as a fresh user message at each firing.',
    inputSchema: {
      type: 'object',
      properties: {
        cron: {
          type: 'string',
          description: 'Standard 5-field cron expression: "minute hour day-of-month month day-of-week". Example: "0 9 * * *" for every day at 9:00.',
        },
        prompt: {
          type: 'string',
          description: 'Prompt delivered to the agent at each firing.',
        },
        name: {
          type: 'string',
          description: 'Human-readable name shown in the UI.',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone name (e.g. "Asia/Tokyo"). Defaults to system timezone.',
        },
      },
      required: ['cron', 'prompt', 'name'],
    },
  },
  {
    name: 'list_cron_jobs',
    description: 'List all currently scheduled jobs (both recurring cron jobs and oneshot timers).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remove_cron_job',
    description: 'Delete a scheduled job by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Job id to remove (matches `id` returned from `list_cron_jobs`).',
        },
      },
      required: ['id'],
    },
  },
]

interface BuiltinToolDeps {
  listCronJobs: () => Promise<AgentRuntimeCronJob[] | null>
  addCronJob: (job: AgentRuntimeCronJobInput) => Promise<AgentRuntimeCronJob | null>
  removeCronJob: (id: string) => Promise<{ ok: boolean } | null>
}

export function createBuiltinToolInvoker(deps: BuiltinToolDeps): ToolInvoker {
  return {
    invoke: async (_callId, toolName, input) => {
      const args = (input ?? {}) as Record<string, unknown>
      switch (toolName as BuiltinToolName) {
        case 'schedule_oneshot': {
          const durationMs = Number(args.durationMs)
          if (!Number.isFinite(durationMs) || durationMs < 1000)
            throw new Error('schedule_oneshot: durationMs must be >= 1000')
          if (durationMs > MAX_ONESHOT_DURATION_MS)
            throw new Error(`schedule_oneshot: durationMs must be <= ${MAX_ONESHOT_DURATION_MS} (30 days)`)
          const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
          if (!prompt)
            throw new Error('schedule_oneshot: prompt required')
          const name = typeof args.name === 'string' && args.name.trim().length > 0
            ? args.name.trim()
            : `Timer +${Math.round(durationMs / 1000)}s`
          const fireAt = new Date(Date.now() + durationMs).toISOString()
          const id = `timer-${crypto.randomUUID()}`
          const created = await deps.addCronJob({
            id,
            name,
            kind: 'oneshot',
            fireAt,
            prompt,
            enabled: true,
          })
          if (!created)
            throw new Error('schedule_oneshot: IPC bridge unavailable')
          return { ok: true, id: created.id, fireAt: created.kind === 'oneshot' ? created.fireAt : fireAt }
        }
        case 'schedule_cron': {
          const cron = typeof args.cron === 'string' ? args.cron.trim() : ''
          if (!cron)
            throw new Error('schedule_cron: cron required')
          const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
          if (!prompt)
            throw new Error('schedule_cron: prompt required')
          const name = (typeof args.name === 'string' && args.name.trim().length > 0) ? args.name.trim() : `Cron ${cron}`
          const timezone = typeof args.timezone === 'string' && args.timezone.length > 0 ? args.timezone : undefined
          const id = `cron-${crypto.randomUUID()}`
          const created = await deps.addCronJob({
            id,
            name,
            kind: 'cron',
            cron,
            prompt,
            enabled: true,
            ...(timezone ? { timezone } : {}),
          })
          if (!created)
            throw new Error('schedule_cron: IPC bridge unavailable')
          return { ok: true, id: created.id, nextRunAt: created.nextRunAt }
        }
        case 'list_cron_jobs': {
          const jobs = (await deps.listCronJobs()) ?? []
          return { jobs }
        }
        case 'remove_cron_job': {
          const id = typeof args.id === 'string' ? args.id.trim() : ''
          if (!id)
            throw new Error('remove_cron_job: id required')
          const res = await deps.removeCronJob(id)
          return { ok: !!res?.ok }
        }
        default:
          throw new Error(`Unknown built-in tool: ${toolName}`)
      }
    },
    cancel: () => {
      // Built-in tools are synchronous IPC round-trips; nothing to cancel.
    },
  }
}

function createCompositeToolInvoker(builtin: ToolInvoker, mcp: ToolInvoker): ToolInvoker {
  return {
    invoke: (callId, toolName, input, signal) => {
      if (isBuiltinToolName(toolName))
        return builtin.invoke(callId, toolName, input, signal)
      return mcp.invoke(callId, toolName, input, signal)
    },
    cancel: (callId) => {
      builtin.cancel(callId)
      mcp.cancel(callId)
    },
  }
}

export const useAgentRuntimeStore = defineStore('modules:agent-runtime', () => {
  const fetchStatus = safeInvoke(_agentRuntimeStatus)
  const invokeSetEnabled = safeInvoke(_agentRuntimeSetEnabled)
  const invokeReloadSkills = safeInvoke(_agentRuntimeReloadSkills)
  const invokeListCronJobs = safeInvoke(_agentRuntimeListCronJobs)
  const invokeAddCronJob = safeInvoke(_agentRuntimeAddCronJob)
  const invokeRemoveCronJob = safeInvoke(_agentRuntimeRemoveCronJob)
  const invokeToggleCronJob = safeInvoke(_agentRuntimeToggleCronJob)

  const enabled = ref<boolean>(false)
  const skills = ref<AgentRuntimeSkillDefinition[]>([])
  const cronJobs = ref<AgentRuntimeCronJob[]>([])
  const activeTurns = ref<number>(0)

  const turnRecords = reactive<Record<string, AgentTurnRecord>>({})
  const recentTurns = ref<string[]>([])
  const runningControllers = new Map<string, AbortController>()

  const pendingApprovals = ref<PendingApprovalRecord[]>([])
  // NOTICE: interactive gate instances are keyed by turnId so resolveApproval
  // can route the user's decision back to the harness that originated it.
  // Without this, a shared gate would race across concurrent turns.
  const approvalGatesByTurn = new Map<string, ReturnType<typeof createInteractiveApprovalGate>>()
  const approvalTurnByRequestId = new Map<string, string>()

  const configured = computed(() => enabled.value)

  async function resolveChatProvider(): Promise<{ provider: ChatProvider, model: string } | null> {
    const consciousness = useConsciousnessStore()
    const providers = useProvidersStore()
    const providerId = consciousness.activeProvider
    const modelId = consciousness.activeModel
    if (!providerId || !modelId)
      return null
    try {
      const instance = await providers.getProviderInstance<ChatProvider>(providerId)
      if (!instance || typeof (instance as ChatProvider).chat !== 'function')
        return null
      return { provider: instance as ChatProvider, model: modelId }
    }
    catch (error) {
      console.warn('[AgentRuntime] Failed to resolve provider instance:', errorMessageFrom(error))
      return null
    }
  }

  function recordEvent(turnId: string, event: AgentEvent) {
    const rec = turnRecords[turnId]
    if (!rec)
      return
    rec.events.push(event)
  }

  function recordPartial(turnId: string, chunk: PartialReply) {
    const rec = turnRecords[turnId]
    if (!rec)
      return
    if (chunk.kind === 'text-delta')
      rec.text += chunk.text
  }

  async function dispatchTurn(input: {
    turnId: string
    prompt: string
    jobId?: string
    systemPrompt?: string
    extraTools?: ToolDefinition[]
    maxToolCalls?: number
  }): Promise<{ ok: boolean, stopReason?: StopReason, error?: string }> {
    const { turnId, prompt, jobId, systemPrompt, extraTools, maxToolCalls } = input

    const resolved = await resolveChatProvider()
    if (!resolved) {
      const error = 'agent-runtime: no chat provider / model configured'
      turnRecords[turnId] = {
        turnId,
        jobId,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        text: '',
        events: [],
        error,
        stopReason: 'error',
      }
      recentTurns.value.unshift(turnId)
      return { ok: false, error }
    }

    const modelDriver: ModelDriver = createXsaiModelDriver({
      model: resolved.model,
      chatProvider: resolved.provider,
      systemPrompt,
    })
    const builtinInvoker = createBuiltinToolInvoker({
      listCronJobs: () => invokeListCronJobs(),
      addCronJob: job => invokeAddCronJob(job),
      removeCronJob: (id: string) => invokeRemoveCronJob({ id }),
    })
    const toolInvoker = createCompositeToolInvoker(builtinInvoker, createMcpToolInvoker())
    const approvalGate = createInteractiveApprovalGate({
      emit: (request: ApprovalRequest) => {
        approvalTurnByRequestId.set(request.id, turnId)
        pendingApprovals.value.push({
          id: request.id,
          turnId,
          plan: request.plan,
          createdAt: Date.now(),
        })
      },
      onSettled: (id) => {
        approvalTurnByRequestId.delete(id)
        const idx = pendingApprovals.value.findIndex(p => p.id === id)
        if (idx >= 0)
          pendingApprovals.value.splice(idx, 1)
      },
    })
    approvalGatesByTurn.set(turnId, approvalGate)
    const harness = createAgentHarness({ modelDriver, toolInvoker, approvalGate })

    const messages: AgentMessage[] = [{ role: 'user', content: prompt }]

    const controller = new AbortController()
    runningControllers.set(turnId, controller)
    activeTurns.value = runningControllers.size

    const record: AgentTurnRecord = {
      turnId,
      jobId,
      startedAt: Date.now(),
      text: '',
      events: [],
    }
    turnRecords[turnId] = record
    recentTurns.value.unshift(turnId)
    if (recentTurns.value.length > 50)
      recentTurns.value.length = 50

    // Merge built-in tools with caller-provided extras, letting extras shadow
    // builtins when they share a name (lets callers override schemas if
    // needed without having to re-declare every built-in).
    const extras = extraTools ?? []
    const extraNames = new Set(extras.map(t => t.name))
    const mergedTools: ToolDefinition[] = [
      ...agentRuntimeBuiltinTools.filter(t => !extraNames.has(t.name)),
      ...extras,
    ]

    try {
      const result = await harness.runAttempt({
        turn: {
          messages,
          tools: mergedTools,
          systemPrompt,
        },
        onPartialReply: chunk => recordPartial(turnId, chunk),
        onAgentEvent: event => recordEvent(turnId, event),
        signal: controller.signal,
        maxToolCalls,
      })

      record.finishedAt = Date.now()
      record.stopReason = result.stopReason
      return { ok: true, stopReason: result.stopReason }
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? 'runAttempt failed'
      record.finishedAt = Date.now()
      record.stopReason = 'error'
      record.error = message
      return { ok: false, error: message }
    }
    finally {
      runningControllers.delete(turnId)
      approvalGatesByTurn.delete(turnId)
      // Drop any approvals that were still pending for this turn (e.g. on abort
      // they would be cleaned up by onSettled, but on harness-side errors the
      // gate may still hold entries because nothing ever called resolve()).
      for (let i = pendingApprovals.value.length - 1; i >= 0; i--) {
        if (pendingApprovals.value[i]!.turnId === turnId) {
          approvalTurnByRequestId.delete(pendingApprovals.value[i]!.id)
          pendingApprovals.value.splice(i, 1)
        }
      }
      activeTurns.value = runningControllers.size
    }
  }

  function cancelTurn(turnId: string) {
    const c = runningControllers.get(turnId)
    if (c)
      c.abort()
  }

  function resolveApproval(id: string, decision: ApprovalDecision) {
    const turnId = approvalTurnByRequestId.get(id)
    if (!turnId)
      return
    const gate = approvalGatesByTurn.get(turnId)
    if (!gate)
      return
    gate.resolve(id, decision)
  }

  function cancelAllTurns() {
    for (const [, c] of runningControllers) c.abort()
    runningControllers.clear()
    activeTurns.value = 0
  }

  async function refreshStatus() {
    try {
      const status = await fetchStatus()
      if (!status)
        return
      enabled.value = status.enabled
      // NOTICE: activeTurns is owned by the renderer in Option A — the main
      // process no longer runs turns. We intentionally keep our local counter
      // authoritative and ignore status.activeTurns from the backend.
    }
    catch (error) {
      console.warn('[AgentRuntime] Failed to fetch status:', errorMessageFrom(error))
    }
  }

  async function setEnabled(val: boolean) {
    try {
      const status = await invokeSetEnabled({ enabled: val })
      if (!status)
        return
      enabled.value = status.enabled
      if (!val) {
        cancelAllTurns()
        cronJobs.value = []
      }
      else {
        // Refresh once the scheduler finished loading from disk — otherwise
        // the list reflects the pre-enable empty snapshot and new jobs appear
        // to vanish until the user clicks around.
        await listCronJobs()
      }
    }
    catch (error) {
      console.warn('[AgentRuntime] Failed to set enabled:', errorMessageFrom(error))
    }
  }

  async function reloadSkills() {
    try {
      const result = await invokeReloadSkills()
      if (result)
        skills.value = result
    }
    catch (error) {
      console.warn('[AgentRuntime] Failed to reload skills:', errorMessageFrom(error))
    }
  }

  async function listCronJobs() {
    try {
      const result = await invokeListCronJobs()
      if (result)
        cronJobs.value = result
    }
    catch (error) {
      console.warn('[AgentRuntime] Failed to list cron jobs:', errorMessageFrom(error))
    }
  }

  async function addCronJob(
    job: AgentRuntimeCronJobInput,
  ): Promise<{ ok: boolean, error?: string }> {
    try {
      const created = await invokeAddCronJob(job)
      if (!created) {
        // safeInvoke returns null when the Electron IPC bridge is missing — the
        // UI still needs to know so it does not pretend the add succeeded.
        return { ok: false, error: 'IPC bridge unavailable (not running in Electron?)' }
      }
      await listCronJobs()
      return { ok: true }
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? 'Failed to add cron job'
      console.warn('[AgentRuntime] Failed to add cron job:', message)
      return { ok: false, error: message }
    }
  }

  async function removeCronJob(id: string) {
    try {
      await invokeRemoveCronJob({ id })
      await listCronJobs()
    }
    catch (error) {
      console.warn('[AgentRuntime] Failed to remove cron job:', errorMessageFrom(error))
    }
  }

  async function toggleCronJob(id: string, cronEnabled: boolean) {
    try {
      await invokeToggleCronJob({ id, enabled: cronEnabled })
      await listCronJobs()
    }
    catch (error) {
      console.warn('[AgentRuntime] Failed to toggle cron job:', errorMessageFrom(error))
    }
  }

  // Subscribe to cron-trigger events broadcast from main. The renderer owns
  // turn execution, so each trigger spawns a local harness run.
  let cronUnsubscribe: (() => void) | null = null
  function subscribeCronTriggers() {
    if (cronUnsubscribe)
      return
    const ctx = getContextOrNull()
    if (!ctx)
      return
    const off = ctx.on(_agentRuntimeCronTriggered, (event) => {
      const payload = event.body
      if (!payload || !enabled.value)
        return
      void dispatchTurn({
        turnId: payload.turnId,
        prompt: payload.prompt,
        jobId: payload.jobId,
      })
    })
    cronUnsubscribe = typeof off === 'function' ? off : null
  }

  onMounted(() => {
    void refreshStatus().then(() => {
      // NOTICE: list after status so we know whether the runtime is enabled
      // (the main side returns [] while disabled). Keeps the settings page
      // from flashing an empty list when jobs already exist on disk.
      if (enabled.value)
        void listCronJobs()
    })
    subscribeCronTriggers()
  })

  return {
    enabled,
    skills,
    cronJobs,
    activeTurns,
    configured,
    turnRecords,
    recentTurns,
    pendingApprovals,

    refreshStatus,
    setEnabled,
    reloadSkills,
    listCronJobs,
    addCronJob,
    removeCronJob,
    toggleCronJob,
    dispatchTurn,
    cancelTurn,
    resolveApproval,
  }
})
