<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAgentApproval } from '../../composables/agent-approval'

const { t } = useI18n()
const { current, count, approve, reject } = useAgentApproval()

const rejectReason = ref('')

watch(current, () => {
  rejectReason.value = ''
})

const inputPreview = computed(() => {
  const input = current.value?.plan.input
  if (input === undefined || input === null)
    return ''
  try {
    return JSON.stringify(input, null, 2)
  }
  catch {
    return String(input)
  }
})

function onApprove() {
  if (!current.value)
    return
  approve(current.value.id)
}

function onReject() {
  if (!current.value)
    return
  reject(current.value.id, rejectReason.value.trim() || undefined)
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="current"
      :class="[
        'fixed inset-0 z-[9999]',
        'flex items-center justify-center',
        'bg-black/60 backdrop-blur-sm',
      ]"
      role="dialog"
      aria-modal="true"
      data-testid="agent-approval-modal"
    >
      <div
        :class="[
          'w-[min(520px,92vw)]',
          'flex flex-col gap-4',
          'rounded-2xl border border-amber-500/40 bg-neutral-900/95 p-5 text-neutral-100 shadow-xl',
        ]"
      >
        <header :class="['flex items-start justify-between gap-3']">
          <div :class="['flex flex-col gap-0.5']">
            <div :class="['text-xs uppercase tracking-wide text-amber-400']">
              {{ t('settings.pages.modules.agent-runtime.approval.title') }}
            </div>
            <div :class="['text-lg font-semibold']">
              {{ current.plan.toolName }}
            </div>
          </div>
          <div v-if="count > 1" :class="['text-xs text-neutral-400']">
            {{ t('settings.pages.modules.agent-runtime.approval.queued', { count: count - 1 }) }}
          </div>
        </header>

        <section v-if="current.plan.sensitivityReason" :class="['text-sm text-amber-200/90']">
          {{ current.plan.sensitivityReason }}
        </section>

        <section :class="['flex flex-col gap-1']">
          <div :class="['text-xs text-neutral-400']">
            {{ t('settings.pages.modules.agent-runtime.approval.input-label') }}
          </div>
          <pre
            :class="[
              'max-h-48 overflow-auto rounded-xl bg-neutral-950/70 p-3',
              'text-xs font-mono text-neutral-200 whitespace-pre-wrap break-words',
            ]"
          >{{ inputPreview }}</pre>
        </section>

        <section :class="['flex flex-col gap-1']">
          <label :for="`reject-reason-${current.id}`" :class="['text-xs text-neutral-400']">
            {{ t('settings.pages.modules.agent-runtime.approval.reject-reason-label') }}
          </label>
          <input
            :id="`reject-reason-${current.id}`"
            v-model="rejectReason"
            :class="[
              'w-full rounded-lg border border-neutral-700 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100',
              'focus:outline-none focus:ring-2 focus:ring-amber-500/40',
            ]"
            type="text"
            :placeholder="t('settings.pages.modules.agent-runtime.approval.reject-reason-placeholder')"
          >
        </section>

        <footer :class="['mt-1 flex items-center justify-end gap-2']">
          <button
            type="button"
            data-testid="agent-approval-reject"
            :class="[
              'rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200',
              'hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-100',
            ]"
            @click="onReject"
          >
            {{ t('settings.pages.modules.agent-runtime.approval.reject') }}
          </button>
          <button
            type="button"
            data-testid="agent-approval-approve"
            :class="[
              'rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-black',
              'hover:bg-amber-400',
            ]"
            @click="onApprove"
          >
            {{ t('settings.pages.modules.agent-runtime.approval.approve') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
