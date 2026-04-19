<script setup lang="ts">
import type { ClaudeCodeSpeechScope } from '@proj-airi/stage-ui/stores/settings/claude-code'

import type { ClaudeCodeProjectSessionsSummary } from '../../../../shared/claude-code'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useSettingsClaudeCode } from '@proj-airi/stage-ui/stores/settings'
import { FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { claudeCodeListAllSessions } from '../../../../shared/eventa'

const { t } = useI18n()
const claudeCodeSettings = useSettingsClaudeCode()
const { showInChatHistory, speechScope, selectedSessions } = storeToRefs(claudeCodeSettings)

// These localStorage keys are shared with useClaudeCodeSpeech composable
const speechEnabled = useLocalStorage('claude-code-speech-enabled', false)
const projectDir = useLocalStorage('claude-code-speech-project-dir', '')

const scopeOptions: ReadonlyArray<{ value: ClaudeCodeSpeechScope, titleKey: string, descriptionKey: string }> = [
  {
    value: 'current-project',
    titleKey: 'settings.pages.modules.claude-code.fields.speech-scope.options.current-project.title',
    descriptionKey: 'settings.pages.modules.claude-code.fields.speech-scope.options.current-project.description',
  },
  {
    value: 'all-projects-latest',
    titleKey: 'settings.pages.modules.claude-code.fields.speech-scope.options.all-projects-latest.title',
    descriptionKey: 'settings.pages.modules.claude-code.fields.speech-scope.options.all-projects-latest.description',
  },
  {
    value: 'manual-select',
    titleKey: 'settings.pages.modules.claude-code.fields.speech-scope.options.manual-select.title',
    descriptionKey: 'settings.pages.modules.claude-code.fields.speech-scope.options.manual-select.description',
  },
]

const projectDirInactive = computed(() => speechScope.value !== 'current-project')

// --- Manual-select session picker ---
// Slugs replace path separators with `-`, so we split a `cwd` on either Unix
// or Windows separators when displaying a human-readable project name.
const PATH_SEPARATOR_RE = /[\\/]/

function deriveProjectName(slug: string, cwd?: string): string {
  if (cwd != null && cwd.length > 0) {
    const basename = cwd.split(PATH_SEPARATOR_RE).filter(Boolean).pop()
    if (basename != null && basename.length > 0)
      return basename
  }
  const parts = slug.split('-').filter(Boolean)
  return parts.at(-1) ?? slug
}

const invokeListAllSessions = useElectronEventaInvoke(claudeCodeListAllSessions)
const projectSummaries = ref<ClaudeCodeProjectSessionsSummary[]>([])
const loadingSessions = ref(false)
const loadError = ref('')

async function refreshSessions() {
  loadingSessions.value = true
  loadError.value = ''
  try {
    projectSummaries.value = await invokeListAllSessions({})
  }
  catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    loadingSessions.value = false
  }
}

onMounted(() => {
  if (speechScope.value === 'manual-select')
    void refreshSessions()
})

watch(speechScope, (value) => {
  if (value === 'manual-select' && projectSummaries.value.length === 0)
    void refreshSessions()
})

const selectionKey = (slug: string, sessionId: string) => `${slug}::${sessionId}`

const selectedKeys = computed(() => {
  const set = new Set<string>()
  for (const entry of selectedSessions.value)
    set.add(selectionKey(entry.slug, entry.sessionId))
  return set
})

function isSelected(slug: string, sessionId: string) {
  return selectedKeys.value.has(selectionKey(slug, sessionId))
}

function toggleSession(slug: string, sessionId: string, checked: boolean) {
  const key = selectionKey(slug, sessionId)
  const next = selectedSessions.value.filter(entry => selectionKey(entry.slug, entry.sessionId) !== key)
  if (checked)
    next.push({ slug, sessionId })
  selectedSessions.value = next
}

function formatLastActivity(iso?: string) {
  if (!iso)
    return ''
  try {
    return new Date(iso).toLocaleString()
  }
  catch {
    return iso
  }
}

function shortSessionId(sessionId: string) {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId
}

const totalSessionCount = computed(() => projectSummaries.value.reduce((acc, p) => acc + p.sessions.length, 0))
</script>

<template>
  <div class="flex flex-col gap-6 p-4">
    <div class="flex flex-col gap-4">
      <FieldCheckbox
        v-model="speechEnabled"
        :label="t('settings.pages.modules.claude-code.fields.speech-enabled.title')"
        :description="t('settings.pages.modules.claude-code.fields.speech-enabled.description')"
      />

      <FieldCheckbox
        v-model="showInChatHistory"
        :label="t('settings.pages.modules.claude-code.fields.show-in-chat-history.title')"
        :description="t('settings.pages.modules.claude-code.fields.show-in-chat-history.description')"
      />

      <div :class="['flex flex-col gap-2']">
        <div :class="['flex flex-col']">
          <span :class="['font-medium text-neutral-700 dark:text-neutral-300']">
            {{ t('settings.pages.modules.claude-code.fields.speech-scope.title') }}
          </span>
          <span :class="['text-sm text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.modules.claude-code.fields.speech-scope.description') }}
          </span>
        </div>
        <div :class="['flex flex-col gap-2']">
          <label
            v-for="option in scopeOptions"
            :key="option.value"
            :class="[
              'flex cursor-pointer items-start gap-3 rounded-xl p-3',
              'border-2 border-solid transition-colors duration-200',
              speechScope === option.value
                ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-100 dark:border-primary-900'
                : 'bg-white dark:bg-neutral-900/20 border-neutral-100 dark:border-neutral-900 hover:border-primary-500/30 dark:hover:border-primary-400/30',
            ]"
          >
            <input
              v-model="speechScope"
              type="radio"
              name="claude-code-speech-scope"
              :value="option.value"
              :class="['mt-1 accent-primary-500 dark:accent-primary-400']"
            >
            <div :class="['flex flex-col']">
              <span :class="['font-medium text-neutral-700 dark:text-neutral-300']">
                {{ t(option.titleKey) }}
              </span>
              <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">
                {{ t(option.descriptionKey) }}
              </span>
            </div>
          </label>
        </div>
      </div>

      <div v-if="speechScope === 'manual-select'" :class="['flex flex-col gap-3']">
        <div :class="['flex items-center justify-between']">
          <div :class="['flex flex-col']">
            <span :class="['font-medium text-neutral-700 dark:text-neutral-300']">
              {{ t('settings.pages.modules.claude-code.fields.manual-select.title') }}
            </span>
            <span :class="['text-xs text-neutral-500 dark:text-neutral-400']">
              {{ t('settings.pages.modules.claude-code.fields.manual-select.subtitle', {
                selected: selectedSessions.length,
                total: totalSessionCount,
              }) }}
            </span>
          </div>
          <button
            type="button"
            :disabled="loadingSessions"
            :class="[
              'rounded-lg px-3 py-1 text-xs',
              'border border-solid border-neutral-200 dark:border-neutral-700',
              'bg-white dark:bg-neutral-900 hover:bg-neutral-50 dark:hover:bg-neutral-800',
              'disabled:cursor-not-allowed disabled:opacity-50',
            ]"
            @click="refreshSessions"
          >
            {{ loadingSessions
              ? t('settings.pages.modules.claude-code.fields.manual-select.refreshing')
              : t('settings.pages.modules.claude-code.fields.manual-select.refresh') }}
          </button>
        </div>

        <div
          v-if="loadError"
          :class="['rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300']"
        >
          {{ loadError }}
        </div>

        <div
          v-else-if="!loadingSessions && projectSummaries.length === 0"
          :class="['rounded-lg bg-neutral-50 p-3 text-sm text-neutral-500 dark:bg-neutral-900/20 dark:text-neutral-400']"
        >
          {{ t('settings.pages.modules.claude-code.fields.manual-select.empty') }}
        </div>

        <div
          v-else
          :class="[
            'max-h-96 overflow-y-auto rounded-xl',
            'border border-solid border-neutral-100 dark:border-neutral-800',
          ]"
        >
          <div v-for="project in projectSummaries" :key="project.slug" :class="['flex flex-col']">
            <div
              :class="[
                'sticky top-0 z-10 px-4 py-2',
                'bg-neutral-50 dark:bg-neutral-900/80',
                'border-b border-solid border-neutral-100 dark:border-neutral-800',
              ]"
            >
              <span :class="['font-medium text-sm text-neutral-700 dark:text-neutral-200']">
                {{ deriveProjectName(project.slug, project.sessions[0]?.cwd) }}
              </span>
              <span :class="['ml-2 text-xs text-neutral-400 dark:text-neutral-500']">
                {{ project.slug }}
              </span>
            </div>
            <ul v-if="project.sessions.length > 0" :class="['flex flex-col']">
              <li
                v-for="session in project.sessions"
                :key="session.sessionId"
                :class="[
                  'flex items-center gap-3 px-4 py-2',
                  'border-b border-solid border-neutral-50 last:border-b-0 dark:border-neutral-800/60',
                ]"
              >
                <input
                  type="checkbox"
                  :checked="isSelected(project.slug, session.sessionId)"
                  :class="['accent-primary-500 dark:accent-primary-400']"
                  @change="(event) => toggleSession(project.slug, session.sessionId, (event.target as HTMLInputElement).checked)"
                >
                <span :class="['flex-1 font-mono text-xs text-neutral-700 dark:text-neutral-300']">
                  {{ shortSessionId(session.sessionId) }}
                </span>
                <span :class="['text-xs text-neutral-400 dark:text-neutral-500']">
                  {{ formatLastActivity(session.lastEventAt) }}
                </span>
              </li>
            </ul>
            <div
              v-else
              :class="['px-4 py-2 text-xs text-neutral-400 dark:text-neutral-500']"
            >
              {{ t('settings.pages.modules.claude-code.fields.manual-select.no-sessions-in-project') }}
            </div>
          </div>
        </div>
      </div>

      <div :class="[projectDirInactive ? 'opacity-60' : '']">
        <FieldInput
          v-model="projectDir"
          :label="t('settings.pages.modules.claude-code.fields.project-dir.title')"
          :description="t('settings.pages.modules.claude-code.fields.project-dir.description')"
          :placeholder="t('settings.pages.modules.claude-code.fields.project-dir.placeholder')"
        />
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.claude-code.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
