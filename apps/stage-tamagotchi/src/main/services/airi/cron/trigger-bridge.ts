import type { CronTriggerEvent } from '@proj-airi/cron-runtime'

export function createCronTriggerBridge(deps: {
  broadcast: (payload: { jobId: string, turnId: string, prompt: string, skillId?: string }) => void
}): (event: CronTriggerEvent) => void {
  return (event: CronTriggerEvent): void => {
    const turnId = crypto.randomUUID()
    const { job } = event
    deps.broadcast({
      jobId: job.id,
      turnId,
      prompt: job.prompt,
      skillId: job.skillId,
    })
  }
}
