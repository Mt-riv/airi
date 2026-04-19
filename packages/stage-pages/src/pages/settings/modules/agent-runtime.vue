<script setup lang="ts">
import { useAgentRuntimeStore } from '@proj-airi/stage-ui/stores/modules/agent-runtime'
import { Button, FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { reactive, ref } from 'vue'

const store = useAgentRuntimeStore()
const { enabled, skills, cronJobs } = storeToRefs(store)

// NOTICE: Route v-model through the store action so the toggle actually hits
// main (cron scheduler start/stop + persistence). A bare `v-model="enabled"`
// would only flip the local Pinia ref without calling `setEnabled`, so main
// never transitions and any subsequent addCronJob is rejected with
// "agent-runtime-disabled" — which the store silently warns about.
async function handleEnabledChange(val: boolean) {
  await store.setEnabled(val)
}

const reloadingSkills = ref(false)
async function handleReloadSkills() {
  reloadingSkills.value = true
  try {
    await store.reloadSkills()
  }
  finally {
    reloadingSkills.value = false
  }
}

const newJob = reactive({
  id: '',
  name: '',
  kind: 'cron' as const,
  cron: '',
  prompt: '',
  enabled: true,
})
const addingJob = ref(false)
const addJobError = ref('')

async function handleAddCronJob() {
  if (!newJob.id.trim() || !newJob.cron.trim() || !newJob.prompt.trim() || !newJob.name.trim()) {
    addJobError.value = 'All fields are required.'
    return
  }
  if (!enabled.value) {
    addJobError.value = 'Enable Agent Runtime before adding a cron job.'
    return
  }
  addJobError.value = ''
  addingJob.value = true
  try {
    const result = await store.addCronJob({ ...newJob })
    if (!result.ok) {
      addJobError.value = result.error ?? 'Failed to add cron job.'
      return
    }
    newJob.id = ''
    newJob.name = ''
    newJob.cron = ''
    newJob.prompt = ''
    newJob.enabled = true
  }
  finally {
    addingJob.value = false
  }
}

async function handleRemoveCronJob(id: string) {
  await store.removeCronJob(id)
}

async function handleToggleCronJob(id: string, enabled: boolean) {
  await store.toggleCronJob(id, enabled)
}
</script>

<template>
  <div :class="['flex flex-col gap-6 p-4']">
    <!-- Enable section -->
    <section :class="['flex flex-col gap-4 rounded-xl border border-neutral-200/70 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900/40']">
      <h2 :class="['text-sm text-neutral-500 font-medium uppercase tracking-wide dark:text-neutral-400']">
        General
      </h2>
      <FieldCheckbox
        :model-value="enabled"
        label="Enable Agent Runtime"
        description="Allow Airi to run autonomous skills and scheduled cron jobs in the background."
        @update:model-value="handleEnabledChange"
      />
    </section>

    <!-- Skills section -->
    <section :class="['flex flex-col gap-4 rounded-xl border border-neutral-200/70 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900/40']">
      <div :class="['flex items-center justify-between']">
        <h2 :class="['text-sm text-neutral-500 font-medium uppercase tracking-wide dark:text-neutral-400']">
          Skills
        </h2>
        <Button
          variant="secondary"
          size="sm"
          :loading="reloadingSkills"
          @click="handleReloadSkills"
        >
          Reload Skills
        </Button>
      </div>

      <div
        v-if="skills.length === 0"
        :class="['flex items-center justify-center rounded-lg border border-dashed border-neutral-300 py-8 text-sm text-neutral-400 dark:border-neutral-700 dark:text-neutral-500']"
      >
        No skills loaded
      </div>

      <ul v-else :class="['flex flex-col gap-2']">
        <li
          v-for="skill in skills"
          :key="skill.id"
          :class="['rounded-lg border border-neutral-200/70 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-800/40']"
        >
          <div :class="['flex items-start justify-between gap-2']">
            <div :class="['flex flex-col gap-0.5']">
              <span :class="['text-sm font-medium text-neutral-800 dark:text-neutral-200']">{{ skill.name }}</span>
              <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">{{ skill.description }}</span>
              <div v-if="skill.triggers.length > 0" :class="['mt-1 flex flex-wrap gap-1']">
                <span
                  v-for="trigger in skill.triggers"
                  :key="trigger"
                  :class="['rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 font-mono dark:bg-neutral-700 dark:text-neutral-300']"
                >
                  {{ trigger }}
                </span>
              </div>
            </div>
            <span :class="['shrink-0 text-xs text-neutral-400 font-mono dark:text-neutral-500']">{{ skill.id }}</span>
          </div>
        </li>
      </ul>
    </section>

    <!-- Cron Jobs section -->
    <section :class="['flex flex-col gap-4 rounded-xl border border-neutral-200/70 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900/40']">
      <h2 :class="['text-sm text-neutral-500 font-medium uppercase tracking-wide dark:text-neutral-400']">
        Cron Jobs
      </h2>

      <ul v-if="cronJobs.length > 0" :class="['flex flex-col gap-2']">
        <li
          v-for="job in cronJobs"
          :key="job.id"
          :class="['rounded-lg border border-neutral-200/70 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-800/40']"
        >
          <div :class="['flex items-start justify-between gap-2']">
            <div :class="['flex min-w-0 flex-col gap-0.5']">
              <div :class="['flex items-center gap-1.5']">
                <span
                  :class="[
                    'rounded px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide',
                    job.kind === 'oneshot'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                      : 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
                  ]"
                >
                  {{ job.kind === 'oneshot' ? 'Timer' : 'Cron' }}
                </span>
                <span :class="['text-sm font-medium text-neutral-800 dark:text-neutral-200']">{{ job.name || job.id }}</span>
              </div>
              <span :class="['text-xs text-neutral-500 font-mono dark:text-neutral-400']">
                {{ job.kind === 'oneshot' ? `Fires once at ${job.fireAt}` : job.cron }}
              </span>
              <span :class="['truncate text-xs text-neutral-400 dark:text-neutral-500']">{{ job.prompt }}</span>
              <span v-if="job.nextRunAt" :class="['text-xs text-neutral-400 dark:text-neutral-500']">
                Next: {{ job.nextRunAt }}
              </span>
            </div>
            <div :class="['flex shrink-0 items-center gap-2']">
              <FieldCheckbox
                :model-value="job.enabled"
                label="Enabled"
                @update:model-value="(val) => handleToggleCronJob(job.id, val)"
              />
              <Button
                variant="danger"
                size="sm"
                @click="handleRemoveCronJob(job.id)"
              >
                Delete
              </Button>
            </div>
          </div>
        </li>
      </ul>

      <div
        v-else
        :class="['flex items-center justify-center rounded-lg border border-dashed border-neutral-300 py-6 text-sm text-neutral-400 dark:border-neutral-700 dark:text-neutral-500']"
      >
        No cron jobs configured
      </div>

      <!-- Add cron job form -->
      <div :class="['flex flex-col gap-3 border-t border-neutral-200/70 pt-4 dark:border-neutral-700']">
        <h3 :class="['text-xs text-neutral-500 font-medium uppercase tracking-wide dark:text-neutral-400']">
          Add Cron Job
        </h3>
        <div :class="['grid grid-cols-1 gap-3 md:grid-cols-2']">
          <FieldInput
            v-model="newJob.id"
            label="Job ID"
            description="Unique identifier for this job."
            placeholder="e.g. daily-summary"
          />
          <FieldInput
            v-model="newJob.name"
            label="Name"
            description="Human-readable name for this job."
            placeholder="e.g. Daily Summary"
          />
          <FieldInput
            v-model="newJob.cron"
            label="Cron Expression"
            description="Standard cron syntax (minute hour day month weekday)."
            placeholder="e.g. 0 9 * * *"
          />
        </div>
        <FieldInput
          v-model="newJob.prompt"
          label="Prompt"
          description="The prompt Airi will run on schedule."
          placeholder="Summarize today's events and share a brief update."
        />
        <FieldCheckbox
          v-model="newJob.enabled"
          label="Enable immediately"
          description="Start running this cron job as soon as it is added."
        />
        <p v-if="addJobError" :class="['text-sm text-red-500 dark:text-red-400']">
          {{ addJobError }}
        </p>
        <div :class="['flex justify-end']">
          <Button
            variant="primary"
            size="sm"
            :loading="addingJob"
            @click="handleAddCronJob"
          >
            Add Job
          </Button>
        </div>
      </div>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: Agent Runtime
  subtitle: Settings
  stageTransition:
    name: slide
</route>
