<script setup lang="ts">
import type { SpeechProvider } from '@xsai-ext/providers/utils'

import {
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { storeToRefs } from 'pinia'
import { computed, onMounted } from 'vue'

const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)

const providerId = 'voicevox'
const defaultModel = 'voicevox'

const availableVoices = computed(() => {
  return speechStore.availableVoices[providerId] || []
})

onMounted(async () => {
  providersStore.initializeProvider(providerId)
  if (!providers.value[providerId]) {
    providers.value[providerId] = { baseUrl: 'http://127.0.0.1:50021' }
  }
  if (!providers.value[providerId].baseUrl) {
    providers.value[providerId].baseUrl = 'http://127.0.0.1:50021'
  }

  // Mark as added so it appears in consciousness settings speech selector
  providersStore.markProviderAdded(providerId)
  providersStore.forceProviderConfigured(providerId)

  await providersStore.fetchModelsForProvider(providerId)
  await speechStore.loadVoicesForProvider(providerId)
})

async function handleGenerateSpeech(input: string, voiceId: string, _useSSML: boolean) {
  const provider = await providersStore.getProviderInstance<SpeechProvider<string>>(providerId)
  if (!provider) {
    throw new Error('Failed to initialize VOICEVOX speech provider')
  }

  const providerConfig = providersStore.getProviderConfig(providerId)

  return await speechStore.speech(
    provider,
    defaultModel,
    input,
    voiceId,
    providerConfig,
  )
}
</script>

<template>
  <SpeechProviderSettings
    :provider-id="providerId"
    :default-model="defaultModel"
  >
    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="true"
        default-text="こんにちは！VOICEVOXのテストです。"
      />
    </template>
  </SpeechProviderSettings>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
