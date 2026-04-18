import type { CronTriggerEvent } from '@proj-airi/cron-runtime'
import type { SkillDefinition } from '@proj-airi/skill-registry'

import process from 'node:process'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCronScheduler, createFakeClock, createMemoryJobStore } from '@proj-airi/cron-runtime'
import { createSkillRegistry, discoverSkills } from '@proj-airi/skill-registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCronTriggerBridge } from '../../src/main/services/airi/cron/trigger-bridge'

// Gate: this suite exercises the real cron + skill-registry + trigger-bridge
// wiring end-to-end. It does NOT spawn Electron, does NOT hit an LLM, and does
// NOT touch the user's `~/.airi` directory — all state is redirected to a
// throwaway tmp directory. It's opt-in because we want PR CI to stay fast;
// run it locally with:
//
//   AIRI_TEST_AGENT_RUNTIME=1 pnpm -F @proj-airi/stage-tamagotchi exec \
//     vitest run test/integration/agent-runtime.test.ts
//
// The suite intentionally keeps the happy-path assertions thin so it serves as
// a regression guard for wiring changes rather than a behaviour spec of any
// individual module. Detailed behavioural coverage lives next to each
// unit (e.g. packages/agent-runtime/src/*.test.ts).
const INTEGRATION_ENABLED = process.env.AIRI_TEST_AGENT_RUNTIME === '1'
const describeIntegration = INTEGRATION_ENABLED ? describe : describe.skip

const SAMPLE_SKILL = `---
id: integration-echo
name: Integration Echo
description: Used by the agent-runtime integration suite to verify skill discovery.
triggers:
  - "echo"
  - "please ?respond"
tools:
  - name: mock.echo
    description: Echo the input argument back.
allowed:
  shellCommands:
    - /bin/true
---

When the user says "echo X", call mock.echo with { text: "X" }.
`

describeIntegration('agent-runtime (integration — scheduler + skills wiring)', () => {
  let skillsRoot: string

  beforeEach(async () => {
    skillsRoot = await mkdtemp(join(tmpdir(), 'airi-agent-it-skills-'))
    await mkdir(join(skillsRoot, 'integration-echo'))
    await writeFile(join(skillsRoot, 'integration-echo', 'SKILL.md'), SAMPLE_SKILL, 'utf-8')
  })

  afterEach(async () => {
    await rm(skillsRoot, { recursive: true, force: true })
  })

  it('discovers a SKILL.md file and resolves it by trigger', async () => {
    const discovered: SkillDefinition[] = await discoverSkills([skillsRoot])
    expect(discovered).toHaveLength(1)
    expect(discovered[0]?.id).toBe('integration-echo')

    const registry = createSkillRegistry()
    for (const s of discovered)
      registry.register(s)

    const matches = registry.resolve('please echo hello back')
    expect(matches[0]?.id).toBe('integration-echo')
  })

  it('forwards a cron trigger through the bridge with a fresh turn id', async () => {
    const clock = createFakeClock(0)
    const store = createMemoryJobStore()

    const fired: CronTriggerEvent[] = []
    const scheduler = createCronScheduler({
      store,
      clock,
      onTrigger: event => fired.push(event),
    })

    await scheduler.start()
    await scheduler.addJob({
      id: 'integration-ping',
      name: 'Integration Ping',
      // Next firing at minute boundary; with now=0 the fake clock just needs
      // to advance to the next "minute" tick to produce a CronTriggerEvent.
      cron: '* * * * *',
      prompt: 'please echo hello back',
      enabled: true,
    })

    clock.advance(60_000)

    expect(fired.length).toBeGreaterThanOrEqual(1)

    const broadcasts: Array<{ jobId: string, turnId: string, prompt: string, skillId?: string }> = []
    const bridge = createCronTriggerBridge({
      broadcast: payload => broadcasts.push(payload),
    })

    for (const evt of fired)
      bridge(evt)

    expect(broadcasts).toHaveLength(fired.length)
    for (const b of broadcasts) {
      expect(b.jobId).toBe('integration-ping')
      expect(b.prompt).toBe('please echo hello back')
      expect(typeof b.turnId).toBe('string')
      expect(b.turnId.length).toBeGreaterThan(0)
    }

    // Each trigger must carry a distinct turn id; this is the property the
    // renderer relies on to scope per-turn state (approval gates, abort
    // controllers, turn records).
    const turnIds = new Set(broadcasts.map(b => b.turnId))
    expect(turnIds.size).toBe(broadcasts.length)

    await scheduler.stop()
  })
})
