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

export interface AgentRuntimeCronJob {
  id: string
  name: string
  cron: string
  prompt: string
  sessionId?: string
  enabled: boolean
  skillId?: string
  timezone?: string
  lastRunAt?: string
  nextRunAt?: string
}

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
  Omit<AgentRuntimeCronJob, 'nextRunAt' | 'lastRunAt'>
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
    const toolInvoker = createMcpToolInvoker()
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

    try {
      const result = await harness.runAttempt({
        turn: {
          messages,
          tools: extraTools ?? [],
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
      if (!val)
        cancelAllTurns()
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

  async function addCronJob(job: Omit<AgentRuntimeCronJob, 'nextRunAt' | 'lastRunAt'>) {
    try {
      await invokeAddCronJob(job)
      await listCronJobs()
    }
    catch (error) {
      console.warn('[AgentRuntime] Failed to add cron job:', errorMessageFrom(error))
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
    void refreshStatus()
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
