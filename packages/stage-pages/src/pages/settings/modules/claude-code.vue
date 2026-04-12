<script setup lang="ts">
import { useSettingsClaudeCode } from '@proj-airi/stage-ui/stores/settings'
import { FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const claudeCodeSettings = useSettingsClaudeCode()
const { showInChatHistory } = storeToRefs(claudeCodeSettings)

// These localStorage keys are shared with useClaudeCodeSpeech composable
const speechEnabled = useLocalStorage('claude-code-speech-enabled', false)
const projectDir = useLocalStorage('claude-code-speech-project-dir', '')
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

      <FieldInput
        v-model="projectDir"
        :label="t('settings.pages.modules.claude-code.fields.project-dir.title')"
        :description="t('settings.pages.modules.claude-code.fields.project-dir.description')"
        :placeholder="t('settings.pages.modules.claude-code.fields.project-dir.placeholder')"
      />
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
