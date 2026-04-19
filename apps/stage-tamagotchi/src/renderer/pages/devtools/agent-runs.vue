<script setup lang="ts">
import { useAgentRuntimeStore } from '@proj-airi/stage-ui/stores/modules/agent-runtime'
import { storeToRefs } from 'pinia'

const store = useAgentRuntimeStore()
const { enabled, skills, cronJobs, activeTurns, configured } = storeToRefs(store)
</script>

<template>
  <div :class="['flex flex-col gap-4 pb-6']">
    <div :class="['grid gap-3', 'md:grid-cols-2']">
      <!-- Runtime status -->
      <section :class="['rounded-2xl border border-neutral-700/60 bg-neutral-950/40 p-4']">
        <div :class="['mb-2 text-sm text-neutral-400']">
          Runtime Status
        </div>
        <div :class="['grid gap-1 text-sm text-neutral-100']">
          <div>
            enabled:
            <span :class="[enabled ? 'text-green-400' : 'text-neutral-500']">
              {{ enabled }}
            </span>
          </div>
          <div>
            configured:
            <span :class="[configured ? 'text-green-400' : 'text-neutral-500']">
              {{ configured }}
            </span>
          </div>
          <div>
            activeTurns:
            <span :class="[activeTurns > 0 ? 'text-amber-400' : 'text-neutral-500']">
              {{ activeTurns }}
            </span>
          </div>
        </div>
      </section>

      <!-- Skills summary -->
      <section :class="['rounded-2xl border border-neutral-700/60 bg-neutral-950/40 p-4']">
        <div :class="['mb-2 text-sm text-neutral-400']">
          Skills ({{ skills.length }})
        </div>
        <div v-if="skills.length === 0" :class="['text-sm text-neutral-500']">
          No skills loaded
        </div>
        <ul v-else :class="['flex flex-col gap-1']">
          <li
            v-for="skill in skills"
            :key="skill.id"
            :class="['grid gap-0.5 text-sm text-neutral-100']"
          >
            <div>id: <span :class="['font-mono text-xs text-neutral-300']">{{ skill.id }}</span></div>
            <div>name: {{ skill.name }}</div>
            <div>triggers: {{ skill.triggers.join(', ') || 'n/a' }}</div>
          </li>
        </ul>
      </section>

      <!-- Cron jobs summary -->
      <section :class="['rounded-2xl border border-neutral-700/60 bg-neutral-950/40 p-4 md:col-span-2']">
        <div :class="['mb-2 text-sm text-neutral-400']">
          Cron Jobs ({{ cronJobs.length }})
        </div>
        <div v-if="cronJobs.length === 0" :class="['text-sm text-neutral-500']">
          No cron jobs configured
        </div>
        <div v-else :class="['grid gap-3 text-sm text-neutral-100 md:grid-cols-2']">
          <div
            v-for="job in cronJobs"
            :key="job.id"
            :class="['flex flex-col gap-0.5']"
          >
            <div>id: <span :class="['font-mono text-xs text-neutral-300']">{{ job.id }}</span></div>
            <div>kind: <span :class="['font-mono text-xs']">{{ job.kind }}</span></div>
            <div v-if="job.kind === 'cron'">
              cron: <span :class="['font-mono text-xs']">{{ job.cron }}</span>
            </div>
            <div v-else>
              fireAt: <span :class="['font-mono text-xs']">{{ job.fireAt }}</span>
            </div>
            <div>
              enabled:
              <span :class="[job.enabled ? 'text-green-400' : 'text-neutral-500']">{{ job.enabled }}</span>
            </div>
            <div>nextRunAt: {{ job.nextRunAt ?? 'n/a' }}</div>
            <div>lastRunAt: {{ job.lastRunAt ?? 'n/a' }}</div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: Agent Runs
  subtitle: DevTools
  stageTransition:
    name: slide
</route>
