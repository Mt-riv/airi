import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

export const useSettingsClaudeCode = defineStore('settings-claude-code', () => {
  const showInChatHistory = useLocalStorageManualReset<boolean>('settings/claude-code/show-in-chat-history', false)

  const configured = computed(() => showInChatHistory.value)

  function resetState() {
    showInChatHistory.reset()
  }

  return {
    showInChatHistory,
    configured,
    resetState,
  }
})
