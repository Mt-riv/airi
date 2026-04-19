<script setup lang="ts">
import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import {
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'

const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)

const providerId = 'aivisspeech'
const defaultModel = 'voicevox'

const speedScale = ref<number>(1.0)
const pitchScale = ref<number>(0.0)
const intonationScale = ref<number>(1.0)
const volumeScale = ref<number>(1.0)

const availableVoices = computed(() => {
  return speechStore.availableVoices[providerId] || []
})

onMounted(async () => {
  providersStore.initializeProvider(providerId)
  if (!providers.value[providerId]) {
    providers.value[providerId] = { baseUrl: 'http://127.0.0.1:10101' }
  }
  if (!providers.value[providerId].baseUrl) {
    providers.value[providerId].baseUrl = 'http://127.0.0.1:10101'
  }

  // Mark as added so it appears in consciousness settings speech selector
  providersStore.markProviderAdded(providerId)
  providersStore.forceProviderConfigured(providerId)

  await providersStore.fetchModelsForProvider(providerId)
  await speechStore.loadVoicesForProvider(providerId)
})

async function handleGenerateSpeech(input: string, voiceId: string, _useSSML: boolean) {
  const provider = await providersStore.getProviderInstance(providerId) as SpeechProviderWithExtraOptions<string, Record<string, unknown>>
  if (!provider) {
    throw new Error('Failed to initialize AivisSpeech provider')
  }

  const providerConfig = providersStore.getProviderConfig(providerId)

  return await speechStore.speech(
    provider,
    defaultModel,
    input,
    voiceId,
    {
      ...providerConfig,
      speedScale: speedScale.value,
      pitchScale: pitchScale.value,
      intonationScale: intonationScale.value,
      volumeScale: volumeScale.value,
    },
  )
}
</script>

<template>
  <SpeechProviderSettings
    :provider-id="providerId"
    :default-model="defaultModel"
  >
    <template #voice-settings>
      <div flex="~ col gap-4">
        <FieldRange
          v-model="speedScale"
          label="Speed"
          description="Playback speed (speedScale). 1.0 is the engine default."
          :min="0.5" :max="2.0" :step="0.01"
        />
        <FieldRange
          v-model="pitchScale"
          label="Pitch"
          description="Pitch offset (pitchScale). 0.0 is the engine default."
          :min="-0.15" :max="0.15" :step="0.01"
        />
        <FieldRange
          v-model="intonationScale"
          label="Intonation"
          description="Intonation strength (intonationScale). 1.0 is the engine default."
          :min="0.0" :max="2.0" :step="0.01"
        />
        <FieldRange
          v-model="volumeScale"
          label="Volume"
          description="Output volume (volumeScale). 1.0 is the engine default."
          :min="0.0" :max="2.0" :step="0.01"
        />
      </div>
    </template>

    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="true"
        default-text="こんにちは！AivisSpeechのテストです。"
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
