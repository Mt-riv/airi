export type {
  AgentEvent,
  AgentMessage,
  PartialReply,
  StopReason,
  SystemRunPlan,
  ToolDefinition,
} from '@proj-airi/agent-runtime'

export type { CronJob } from '@proj-airi/cron-runtime'
export type { SkillDefinition } from '@proj-airi/skill-registry'

export interface AgentRuntimeStatus {
  enabled: boolean
  skillsLoaded: number
  cronJobsEnabled: number
  activeTurns: number
}
