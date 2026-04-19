<script setup lang="ts">
import { useChatAttachmentStore } from '@proj-airi/stage-ui/stores/chat/attachment-store'
import { useSettingsChatAttachments } from '@proj-airi/stage-ui/stores/settings'
import { ATTACHMENT_LIMITS } from '@proj-airi/stage-ui/types/chat-attachment'
import { FieldCheckbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const settings = useSettingsChatAttachments()
const store = useChatAttachmentStore()
const { enabled, clearAfterSend } = storeToRefs(settings)
const { items, totalBytes, totalTokenEstimate } = storeToRefs(store)

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const limitsSummary = computed(() => ({
  perFile: formatBytes(ATTACHMENT_LIMITS.perFileBytes),
  total: formatBytes(ATTACHMENT_LIMITS.totalBytes),
  count: ATTACHMENT_LIMITS.maxFiles,
}))
</script>

<template>
  <div flex="~ col gap-6">
    <div bg="neutral-100 dark:[rgba(0,0,0,0.3)]" rounded-xl p-4 flex="~ col gap-4">
      <div>
        <h2 class="text-lg text-neutral-500 md:text-2xl dark:text-neutral-500">
          {{ t('settings.pages.modules.memory-short-term.title') }}
        </h2>
        <div text="neutral-400 dark:neutral-400">
          <span>{{ t('settings.pages.modules.memory-short-term.description') }}</span>
        </div>
      </div>

      <FieldCheckbox
        v-model="enabled"
        :label="t('settings.pages.modules.memory-short-term.enable.label')"
        :description="t('settings.pages.modules.memory-short-term.enable.description')"
      />

      <FieldCheckbox
        v-model="clearAfterSend"
        :disabled="!enabled"
        :label="t('settings.pages.modules.memory-short-term.clear-after-send.label')"
        :description="t('settings.pages.modules.memory-short-term.clear-after-send.description')"
      />

      <div
        :class="[
          'rounded-md p-3 text-xs',
          'bg-neutral-50 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400',
        ]"
      >
        {{ t('settings.pages.modules.memory-short-term.limits', limitsSummary) }}
      </div>
    </div>

    <div
      v-if="enabled"
      bg="neutral-100 dark:[rgba(0,0,0,0.3)]"
      rounded-xl p-4 flex="~ col gap-3"
    >
      <div flex="~ row items-center justify-between">
        <h3 class="text text-neutral-500 md:text-xl dark:text-neutral-500">
          {{ t('settings.pages.modules.memory-short-term.attached.title') }}
        </h3>
        <button
          v-if="items.length > 0"
          :class="[
            'rounded-md px-2 py-1 text-xs',
            'text-neutral-500 hover:text-red-500 dark:text-neutral-400',
          ]"
          @click="store.clear()"
        >
          {{ t('stage.attachments.clear') }}
        </button>
      </div>

      <div v-if="items.length === 0" class="text-xs text-neutral-400 dark:text-neutral-500">
        {{ t('settings.pages.modules.memory-short-term.attached.empty') }}
      </div>

      <ul v-else flex="~ col gap-2">
        <li
          v-for="item in items"
          :key="item.id"
          :class="[
            'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs',
            'bg-white/50 dark:bg-black/30',
          ]"
        >
          <div class="i-solar:document-text-bold-duotone text-base text-primary-500" />
          <span class="flex-1 truncate">{{ item.name }}</span>
          <span class="text-neutral-500 opacity-70 dark:text-neutral-400">
            {{ formatBytes(item.sizeBytes) }} · ~{{ item.tokenEstimate }} tok
          </span>
          <button
            :title="t('stage.attachments.remove')"
            :class="[
              'h-5 w-5 flex items-center justify-center rounded-full text-neutral-500',
              'hover:bg-red-500 hover:text-white',
            ]"
            @click="store.remove(item.id)"
          >
            &times;
          </button>
        </li>
      </ul>

      <div
        v-if="items.length > 0"
        class="text-xs text-neutral-500 dark:text-neutral-400"
      >
        {{ t('settings.pages.modules.memory-short-term.attached.summary', { count: items.length, size: formatBytes(totalBytes), tokens: totalTokenEstimate }) }}
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-short-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
