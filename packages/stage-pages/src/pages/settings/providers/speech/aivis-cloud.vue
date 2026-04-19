<script setup lang="ts">
import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import {
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { FieldInput, FieldRange, FieldSelect } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const providerId = 'aivis-cloud'
const defaultBaseUrl = 'https://api.aivis-project.com'
const defaultModelUuid = 'a59cb814-0083-4369-8542-f51a29e72af7' // Anneli (sample default)

const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)
const { t } = useI18n()

const speed = ref<number>(1.0)
const pitch = ref<number>(0.0)
const volume = ref<number>(1.0)
const emotionalIntensity = ref<number>(1.0)
const outputFormat = ref<string>('mp3')

const modelUuid = computed({
  get: () => (providers.value[providerId]?.modelUuid as string | undefined) ?? defaultModelUuid,
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].modelUuid = value
  },
})

const apiKeyConfigured = computed(() => !!providers.value[providerId]?.apiKey)

const availableVoices = computed(() => {
  return speechStore.availableVoices[providerId] || []
})

async function handleGenerateSpeech(input: string, voiceId: string, _useSSML: boolean) {
  const provider = await providersStore.getProviderInstance(providerId) as SpeechProviderWithExtraOptions<string, Record<string, unknown>>
  if (!provider)
    throw new Error('Failed to initialize Aivis Cloud provider')

  const providerConfig = providersStore.getProviderConfig(providerId)
  const effectiveModel = (providerConfig.modelUuid as string | undefined) || defaultModelUuid

  return await speechStore.speech(
    provider,
    effectiveModel,
    input,
    voiceId,
    {
      ...providerConfig,
      speed: speed.value,
      pitch: pitch.value,
      volume: volume.value,
      emotionalIntensity: emotionalIntensity.value,
      outputFormat: outputFormat.value,
    },
  )
}

// NOTE: We intentionally do NOT gate voice-loading on validateProviderConfig
// success. The validator hits `/v1/users/me` which may be blocked by CORS in
// the browser/Electron-renderer context; a failure there still lets the user
// call `/v1/tts/synthesize` (which is the only endpoint needed to preview).
async function reloadVoices() {
  try {
    await speechStore.loadVoicesForProvider(providerId)
  }
  catch (error) {
    console.warn('[aivis-cloud] loadVoicesForProvider failed:', error)
  }
}

onMounted(async () => {
  providersStore.initializeProvider(providerId)

  if (!providers.value[providerId])
    providers.value[providerId] = {}
  if (!providers.value[providerId].baseUrl)
    providers.value[providerId].baseUrl = defaultBaseUrl
  if (!providers.value[providerId].modelUuid)
    providers.value[providerId].modelUuid = defaultModelUuid

  providersStore.markProviderAdded(providerId)
  providersStore.forceProviderConfigured(providerId)

  await providersStore.fetchModelsForProvider(providerId)
  await reloadVoices()
})

watch(providers, reloadVoices, { deep: true })
watch(modelUuid, async () => {
  await providersStore.fetchModelsForProvider(providerId)
  await reloadVoices()
})
</script>

<template>
  <SpeechProviderSettings
    :provider-id="providerId"
    :default-model="modelUuid"
    placeholder="aivis_********"
  >
    <template #basic-settings>
      <FieldInput
        v-model="modelUuid"
        :label="t('settings.pages.providers.provider.aivis-cloud.fields.field.model-uuid.label')"
        :description="t('settings.pages.providers.provider.aivis-cloud.fields.field.model-uuid.description')"
        placeholder="00000000-0000-0000-0000-000000000000"
      />
    </template>

    <template #voice-settings>
      <div flex="~ col gap-4">
        <FieldRange
          v-model="speed"
          :label="t('settings.pages.providers.provider.common.fields.field.speed.label')"
          :description="t('settings.pages.providers.provider.common.fields.field.speed.description')"
          :min="0.5" :max="2.0" :step="0.01"
        />
        <FieldRange
          v-model="pitch"
          :label="t('settings.pages.providers.provider.common.fields.field.pitch.label')"
          :description="t('settings.pages.providers.provider.common.fields.field.pitch.description')"
          :min="-1.0" :max="1.0" :step="0.01"
        />
        <FieldRange
          v-model="volume"
          :label="t('settings.pages.providers.provider.common.fields.field.volume.label')"
          :description="t('settings.pages.providers.provider.common.fields.field.volume.description')"
          :min="0.0" :max="2.0" :step="0.01"
        />
        <FieldRange
          v-model="emotionalIntensity"
          :label="t('settings.pages.providers.provider.aivis-cloud.fields.field.emotional-intensity.label')"
          :description="t('settings.pages.providers.provider.aivis-cloud.fields.field.emotional-intensity.description')"
          :min="0.0" :max="2.0" :step="0.01"
        />
        <FieldSelect
          v-model="outputFormat"
          :label="t('settings.pages.providers.provider.aivis-cloud.fields.field.output-format.label')"
          :description="t('settings.pages.providers.provider.aivis-cloud.fields.field.output-format.description')"
          :options="[
            { value: 'mp3', label: 'MP3' },
            { value: 'wav', label: 'WAV' },
            { value: 'flac', label: 'FLAC' },
            { value: 'aac', label: 'AAC' },
            { value: 'opus', label: 'Opus' },
          ]"
        />
      </div>
    </template>

    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="apiKeyConfigured"
        default-text="こんにちは！Aivis Cloud TTS のテストです。"
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
