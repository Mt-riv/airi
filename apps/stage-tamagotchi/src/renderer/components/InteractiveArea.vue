<script setup lang="ts">
import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'

import { errorMessageFrom } from '@moeru/std'
import { ChatHistory } from '@proj-airi/stage-ui/components'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatAttachmentStore } from '@proj-airi/stage-ui/stores/chat/attachment-store'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useSettingsChatAttachments } from '@proj-airi/stage-ui/stores/settings/chat-attachments'
import { BasicTextarea } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'

import { useChatSyncStore } from '../stores/chat-sync'

const messageInput = ref('')
const attachments = ref<{ type: 'image', data: string, mimeType: string, url: string }[]>([])

const chatOrchestrator = useChatOrchestratorStore()
const chatSession = useChatSessionStore()
const chatStream = useChatStreamStore()
const chatSyncStore = useChatSyncStore()
const chatAttachmentStore = useChatAttachmentStore()
const attachmentSettings = useSettingsChatAttachments()
const { messages } = storeToRefs(chatSession)
const { streamingMessage } = storeToRefs(chatStream)
const { sending } = storeToRefs(chatOrchestrator)
const { items: docAttachments, totalTokenEstimate: docTokenEstimate } = storeToRefs(chatAttachmentStore)
const { enabled: attachmentsEnabled, clearAfterSend } = storeToRefs(attachmentSettings)
const { t } = useI18n()
const isComposing = ref(false)
const DOUBLE_ENTER_INTERVAL_MS = 300
const TRAILING_NEWLINES_REGEX = /[\r\n]+$/
const SEND_MODES = ['enter', 'ctrl-enter', 'double-enter'] as const
type SendMode = (typeof SEND_MODES)[number]
const sendMode = useLocalStorage<SendMode>('ui/chat/settings/send-mode', 'enter')
const lastEnterTime = ref(0)
const sendModeLabels = computed<Record<SendMode, string>>(() => ({
  'enter': t('stage.send-mode.enter'),
  'ctrl-enter': t('stage.send-mode.ctrl-enter'),
  'double-enter': t('stage.send-mode.double-enter'),
}))

async function handleSend() {
  if (isComposing.value) {
    return
  }

  if (!messageInput.value.trim() && !attachments.value.length && !docAttachments.value.length) {
    return
  }

  const textToSend = messageInput.value
  const attachmentsToSend = attachments.value.map(att => ({ ...att }))
  const docAttachmentsToSend = attachmentsEnabled.value
    ? docAttachments.value.map(doc => ({ ...doc }))
    : []

  // optimistic clear
  messageInput.value = ''
  attachments.value = []

  try {
    await chatSyncStore.requestIngest({
      text: textToSend,
      attachments: attachmentsToSend,
      docAttachments: docAttachmentsToSend.length > 0 ? docAttachmentsToSend : undefined,
      toolset: 'widgets',
    })

    attachmentsToSend.forEach(att => URL.revokeObjectURL(att.url))

    if (attachmentsEnabled.value && clearAfterSend.value) {
      chatAttachmentStore.clear()
    }
  }
  catch (error) {
    // restore on failure
    messageInput.value = textToSend
    attachments.value = attachmentsToSend.map(att => ({
      ...att,
      url: URL.createObjectURL(new Blob([Uint8Array.from(atob(att.data), c => c.charCodeAt(0))], { type: att.mimeType })),
    }))
    chatSession.setSessionMessages(chatSession.activeSessionId, [
      ...messages.value,
      {
        role: 'error',
        content: errorMessageFrom(error) ?? 'Failed to send message',
      },
    ])
  }
}

function sendFromKeyboard() {
  messageInput.value = messageInput.value.replace(TRAILING_NEWLINES_REGEX, '')
  void handleSend()
}

function handleMessageInputKeydown(event: KeyboardEvent) {
  if (isComposing.value || event.key !== 'Enter')
    return

  const hasControl = event.ctrlKey || event.metaKey
  const hasShift = event.shiftKey

  switch (sendMode.value) {
    case 'enter':
      if (!hasShift && !hasControl) {
        event.preventDefault()
        sendFromKeyboard()
      }
      return
    case 'ctrl-enter':
      if (hasControl) {
        event.preventDefault()
        sendFromKeyboard()
      }
      return
    case 'double-enter':
      if (!hasShift && !hasControl) {
        const now = Date.now()
        if (now - lastEnterTime.value < DOUBLE_ENTER_INTERVAL_MS) {
          event.preventDefault()
          sendFromKeyboard()
          lastEnterTime.value = 0
        }
        else {
          lastEnterTime.value = now
        }
      }
  }
}

const TEXT_ATTACHMENT_EXTS = /\.(?:txt|md|markdown)$/i

function isTextAttachmentFile(file: File): boolean {
  if (TEXT_ATTACHMENT_EXTS.test(file.name))
    return true
  return file.type === 'text/plain' || file.type === 'text/markdown' || file.type === 'text/x-markdown'
}

async function ingestTextAttachment(file: File) {
  const result = await chatAttachmentStore.addFromFile(file)
  if (!result.ok) {
    const key = `stage.attachments.error.${result.reason}`
    toast.error(t(key, { name: result.name }))
  }
}

async function handleFilePaste(files: File[]) {
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (e) => {
        const base64Data = (e.target?.result as string)?.split(',')[1]
        if (base64Data) {
          attachments.value.push({
            type: 'image' as const,
            data: base64Data,
            mimeType: file.type,
            url: URL.createObjectURL(file),
          })
        }
      }
      reader.readAsDataURL(file)
      continue
    }

    if (attachmentsEnabled.value && isTextAttachmentFile(file)) {
      await ingestTextAttachment(file)
    }
  }
}

function removeAttachment(index: number) {
  const attachment = attachments.value[index]
  if (attachment) {
    URL.revokeObjectURL(attachment.url)
    attachments.value.splice(index, 1)
  }
}

function removeDocAttachment(id: string) {
  chatAttachmentStore.remove(id)
}

function clearDocAttachments() {
  chatAttachmentStore.clear()
}

const fileInputEl = ref<HTMLInputElement | null>(null)
const isDraggingFiles = ref(false)
let dragCounter = 0

function openFilePicker() {
  fileInputEl.value?.click()
}

async function handleFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  for (const file of files) {
    if (isTextAttachmentFile(file))
      await ingestTextAttachment(file)
  }
  input.value = ''
}

function handleDragEnter(event: DragEvent) {
  if (!attachmentsEnabled.value)
    return
  if (!event.dataTransfer?.types.includes('Files'))
    return
  dragCounter += 1
  isDraggingFiles.value = true
}

function handleDragOver(event: DragEvent) {
  if (!attachmentsEnabled.value)
    return
  if (!event.dataTransfer?.types.includes('Files'))
    return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

function handleDragLeave() {
  dragCounter = Math.max(0, dragCounter - 1)
  if (dragCounter === 0)
    isDraggingFiles.value = false
}

async function handleDrop(event: DragEvent) {
  if (!attachmentsEnabled.value)
    return
  if (!event.dataTransfer?.files?.length)
    return
  event.preventDefault()
  dragCounter = 0
  isDraggingFiles.value = false
  const files = Array.from(event.dataTransfer.files)
  await handleFilePaste(files)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

watch(sendMode, () => {
  lastEnterTime.value = 0
})

const historyMessages = computed(() => messages.value as unknown as ChatHistoryItem[])

async function handleDeleteMessage(index: number) {
  await chatSyncStore.requestDeleteMessage({ index })
}
</script>

<template>
  <div
    h-full w-full flex="~ col gap-1"
    class="relative"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <div
      v-if="isDraggingFiles"
      :class="[
        'absolute inset-0 z-20 flex items-center justify-center rounded-xl',
        'pointer-events-none border-2 border-primary-400 border-dashed',
        'bg-primary-100/70 dark:bg-primary-900/60',
        'text-sm text-primary-700 dark:text-primary-200 font-medium',
      ]"
    >
      {{ t('stage.attachments.drop-here') }}
    </div>
    <div w-full flex-1 overflow-hidden>
      <ChatHistory
        :messages="historyMessages"
        :sending="sending"
        :streaming-message="streamingMessage"
        @delete-message="handleDeleteMessage($event.index)"
      />
    </div>
    <div
      v-if="attachments.length > 0"
      :class="[
        'flex flex-wrap gap-2 border-t border-primary-100 p-2',
      ]"
    >
      <div v-for="(attachment, index) in attachments" :key="index" class="relative">
        <img :src="attachment.url" :class="['h-20 w-20 rounded-md object-cover']">
        <button
          :class="[
            'absolute right-1 top-1 h-5 w-5 flex items-center justify-center rounded-full',
            'bg-red-500 text-xs text-white',
          ]"
          @click="removeAttachment(index)"
        >
          &times;
        </button>
      </div>
    </div>
    <div
      v-if="attachmentsEnabled && docAttachments.length > 0"
      :class="[
        'flex flex-wrap items-center gap-2 border-t border-primary-100 px-2 py-1',
      ]"
    >
      <div
        v-for="doc in docAttachments"
        :key="doc.id"
        :class="[
          'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
          'bg-primary-100/60 dark:bg-primary-900/60',
          'text-primary-700 dark:text-primary-100',
        ]"
        :title="doc.content.slice(0, 200)"
      >
        <div class="i-solar:document-text-bold-duotone text-sm" />
        <span class="max-w-40 truncate">{{ doc.name }}</span>
        <span class="text-primary-500 opacity-70 dark:text-primary-300">{{ formatBytes(doc.sizeBytes) }}</span>
        <button
          :title="t('stage.attachments.remove')"
          :class="[
            'h-4 w-4 flex items-center justify-center rounded-full',
            'hover:bg-red-500/80 hover:text-white',
          ]"
          @click="removeDocAttachment(doc.id)"
        >
          &times;
        </button>
      </div>
      <span
        :class="['text-xs text-primary-500 dark:text-primary-300 opacity-70 ml-1']"
      >
        {{ t('stage.attachments.summary', { count: docAttachments.length, tokens: docTokenEstimate }) }}
      </span>
      <button
        v-if="docAttachments.length > 1"
        :title="t('stage.attachments.clear')"
        :class="[
          'ml-auto text-xs text-neutral-500 dark:text-neutral-400 hover:text-red-500',
        ]"
        @click="clearDocAttachments"
      >
        {{ t('stage.attachments.clear') }}
      </button>
    </div>
    <div :class="['flex items-center justify-end gap-2 py-1']">
      <DropdownMenuRoot>
        <DropdownMenuTrigger as-child>
          <button
            :class="[
              'max-h-[10lh] min-h-[1lh] flex items-center justify-center rounded-md p-2 outline-none',
              'transition-colors transition-transform active:scale-95',
            ]"
            bg="neutral-100 dark:neutral-800"
            text="lg neutral-500 dark:neutral-400"
            :title="t('stage.send-mode.title')"
          >
            <div class="i-solar:keyboard-bold-duotone" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="end"
            side="top"
            :side-offset="8"
            :class="[
              'z-50 min-w-[180px] rounded-lg border border-primary-200 bg-white p-1 shadow-xl',
              'dark:border-primary-700 dark:bg-neutral-800',
              'flex flex-col gap-1',
            ]"
          >
            <DropdownMenuItem
              v-for="mode in SEND_MODES"
              :key="mode"
              :class="[
                'w-full flex cursor-pointer items-center rounded-md px-3 py-2 text-left text-xs outline-none transition-colors',
                'hover:bg-primary-100 dark:hover:bg-primary-900/50',
                sendMode === mode ? 'bg-primary-50 text-primary-600 font-semibold dark:bg-primary-900/20 dark:text-primary-300' : 'text-neutral-500',
              ]"
              @select="sendMode = mode"
            >
              <div class="mr-2 h-4 w-4 flex shrink-0 items-center justify-center">
                <div v-if="sendMode === mode" class="i-ph:check-bold text-base" />
              </div>
              <span>{{ sendModeLabels[mode] }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <button
        v-if="attachmentsEnabled"
        :title="t('stage.attachments.pick')"
        :class="[
          'max-h-[10lh] min-h-[1lh]',
        ]"
        bg="neutral-100 dark:neutral-800"
        text="lg neutral-500 dark:neutral-400"
        hover:text="primary-500 dark:primary-300"
        flex items-center justify-center rounded-md p-2 outline-none
        transition-colors transition-transform active:scale-95
        @click="openFilePicker"
      >
        <div class="i-solar:paperclip-bold-duotone" />
      </button>
      <input
        ref="fileInputEl"
        type="file"
        accept=".txt,.md,.markdown,text/plain,text/markdown"
        multiple
        class="hidden"
        @change="handleFileInputChange"
      >

      <button
        :class="[
          'max-h-[10lh] min-h-[1lh]',
        ]"
        bg="neutral-100 dark:neutral-800"
        text="lg neutral-500 dark:neutral-400"
        hover:text="red-500 dark:red-400"
        flex items-center justify-center rounded-md p-2 outline-none
        transition-colors transition-transform active:scale-95
        @click="() => chatSyncStore.requestCleanup()"
      >
        <div class="i-solar:trash-bin-2-bold-duotone" />
      </button>
    </div>
    <BasicTextarea
      v-model="messageInput"
      :submit-on-enter="false"
      :placeholder="t('stage.message')"
      class="ph-no-capture"
      text="primary-600 dark:primary-100  placeholder:primary-500 dark:placeholder:primary-200"
      border="solid 2 primary-200/20 dark:primary-400/20"
      bg="primary-100/50 dark:primary-900/70"
      max-h="[10lh]" min-h="[1lh]"
      w-full shrink-0 resize-none overflow-y-scroll rounded-xl p-2 font-medium outline-none
      transition="all duration-250 ease-in-out placeholder:all placeholder:duration-250 placeholder:ease-in-out"
      @compositionstart="isComposing = true"
      @compositionend="isComposing = false"
      @keydown="handleMessageInputKeydown"
      @paste-file="handleFilePaste"
    />
  </div>
</template>
