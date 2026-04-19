import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

export const useSettingsChatAttachments = defineStore('settings-chat-attachments', () => {
  const enabled = useLocalStorageManualReset<boolean>('settings/chat-attachments/enabled', false)
  const clearAfterSend = useLocalStorageManualReset<boolean>('settings/chat-attachments/clear-after-send', false)

  function resetState() {
    enabled.reset()
    clearAfterSend.reset()
  }

  return {
    enabled,
    clearAfterSend,
    resetState,
  }
})
