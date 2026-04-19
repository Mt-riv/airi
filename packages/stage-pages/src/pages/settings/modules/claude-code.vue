<script setup lang="ts">
import type { ClaudeCodeSpeechScope } from '@proj-airi/stage-ui/stores/settings/claude-code'

import { useSettingsClaudeCode } from '@proj-airi/stage-ui/stores/settings'
import { FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const claudeCodeSettings = useSettingsClaudeCode()
const { showInChatHistory, speechScope } = storeToRefs(claudeCodeSettings)

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
]

const projectDirInactive = computed(() => speechScope.value === 'all-projects-latest')
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
