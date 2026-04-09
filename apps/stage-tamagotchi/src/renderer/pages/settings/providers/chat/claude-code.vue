<script setup lang="ts">
import type { RemovableRef } from '@vueuse/core'

import {
  ProviderAdvancedSettings,
  ProviderBasicSettings,
  ProviderSettingsContainer,
  ProviderSettingsLayout,
  ProviderValidationAlerts,
} from '@proj-airi/stage-ui/components'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { FieldInput } from '@proj-airi/ui'
import { errorMessageFrom } from '@moeru/std'
import { useDebounceFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

// NOTICE: Dedicated settings page for the Claude Code provider.
//
//   - Lives under `apps/stage-tamagotchi/src/renderer/pages/` rather than
//     `packages/stage-pages/src/pages/` because it needs to read/write
//     values the main-process Claude Code service knows how to handle
//     (`binaryPath`, `projectDir`, `sessionId`). The generic legacy
//     `[providerId].vue` template hardcodes ProviderApiKeyInput /
//     ProviderBaseUrlInput and cannot render our schema.
//
//   - The tamagotchi renderer's vue-router scans this folder in
//     addition to the shared `stage-pages` pages, so a file named
//     `claude-code.vue` beats the dynamic `[providerId].vue` route for
//     `/settings/providers/chat/claude-code`.
//
//   - `useProviderValidation` is deliberately NOT used here. Its
//     `debouncedValidateConfiguration` short-circuits for providers
//     that do not carry `apiKey` / `baseUrl` / `accountId` credentials,
//     which silently skips validation for Claude Code. Instead we run
//     the validator ourselves via a local `watch(credentials)` and
//     bind the state into `ProviderValidationAlerts` directly.

const providerId = 'claude-code'
const { t } = useI18n()
const router = useRouter()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore) as { providers: RemovableRef<Record<string, any>> }

const providerMetadata = computed(() => providersStore.getProviderMetadata(providerId))
const credentials = computed(() => providers.value[providerId] || {})

const binaryPath = computed({
  get: () => credentials.value.binaryPath || '',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].binaryPath = value
  },
})

const projectDir = computed({
  get: () => credentials.value.projectDir || '',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].projectDir = value
  },
})

const sessionId = computed({
  get: () => credentials.value.sessionId || '',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].sessionId = value
  },
})

const isValidating = ref(0)
const isValid = ref(false)
const validationMessage = ref('')

async function validateConfiguration() {
  const metadata = providerMetadata.value
  if (!metadata)
    return

  isValidating.value++
  const startedAt = performance.now()
  let nextMessage = ''

  try {
    const result = await metadata.validators.validateProviderConfig(
      { ...credentials.value },
      { skipChatPingCheck: true },
    )
    isValid.value = result.valid
    if (!result.valid)
      nextMessage = result.reason
    if (result.valid)
      providersStore.markProviderAdded(providerId)
  }
  catch (error) {
    isValid.value = false
    nextMessage = t('settings.dialogs.onboarding.validationError', {
      error: errorMessageFrom(error) ?? 'Generic error (claude-code-validate)',
    })
  }
  finally {
    // Match the timing behaviour of useProviderValidation so the spinner
    // is visible for at least ~500ms and does not flicker.
    const elapsed = performance.now() - startedAt
    setTimeout(() => {
      isValidating.value--
      validationMessage.value = nextMessage
    }, Math.max(0, 500 - elapsed))
  }
}

const debouncedValidate = useDebounceFn(validateConfiguration, 500)

watch(credentials, () => {
  debouncedValidate()
}, { deep: true })

onMounted(() => {
  providersStore.initializeProvider(providerId)

  if (!providers.value[providerId])
    providers.value[providerId] = {}

  // Default binary falls back to the `claude` resolved from $PATH so a
  // first-time user does not hit a redundant "field is required" error
  // on top of the real "project directory" check.
  if (!providers.value[providerId].binaryPath)
    providers.value[providerId].binaryPath = 'claude'

  // Kick off an initial validation so the alerts are in sync with the
  // stored (possibly blank) credentials.
  validateConfiguration()
})

function handleResetSettings() {
  const defaults = providerMetadata.value?.defaultOptions ? providerMetadata.value.defaultOptions() : {}
  providers.value[providerId] = { ...defaults, binaryPath: 'claude' }
  isValid.value = false
  validationMessage.value = ''
  isValidating.value = 0
}

function forceValid() {
  isValid.value = true
  validationMessage.value = ''
  providersStore.forceProviderConfigured(providerId)
}

const I18N_PREFIX = 'settings.pages.providers.provider.claude-code'
</script>

<template>
  <ProviderSettingsLayout
    :provider-name="providerMetadata?.localizedName"
    :provider-icon="providerMetadata?.icon"
    :provider-icon-color="providerMetadata?.iconColor"
    :on-back="() => router.back()"
  >
    <ProviderSettingsContainer>
      <ProviderBasicSettings
        :title="t('settings.pages.providers.common.section.basic.title')"
        :description="t('settings.pages.providers.common.section.basic.description')"
        :on-reset="handleResetSettings"
      >
        <div :class="['flex', 'flex-col', 'gap-4']">
          <FieldInput
            v-model="projectDir"
            :label="t(`${I18N_PREFIX}.fields.field.project-dir.label`)"
            :description="t(`${I18N_PREFIX}.fields.field.project-dir.description`)"
            :placeholder="t(`${I18N_PREFIX}.fields.field.project-dir.placeholder`)"
            required
            type="text"
          />

          <FieldInput
            v-model="binaryPath"
            :label="t(`${I18N_PREFIX}.fields.field.binary-path.label`)"
            :description="t(`${I18N_PREFIX}.fields.field.binary-path.description`)"
            :placeholder="t(`${I18N_PREFIX}.fields.field.binary-path.placeholder`)"
            type="text"
          />
        </div>
      </ProviderBasicSettings>

      <ProviderAdvancedSettings :title="t('settings.pages.providers.common.section.advanced.title')">
        <FieldInput
          v-model="sessionId"
          :label="t(`${I18N_PREFIX}.fields.field.session-id.label`)"
          :description="t(`${I18N_PREFIX}.fields.field.session-id.description`)"
          :placeholder="t(`${I18N_PREFIX}.fields.field.session-id.placeholder`)"
          type="text"
        />
      </ProviderAdvancedSettings>

      <ProviderValidationAlerts
        :is-valid="isValid"
        :is-validating="isValidating"
        :validation-message="validationMessage"
        :has-manual-validators="false"
        :is-manual-testing="false"
        :manual-test-passed="false"
        manual-test-message=""
        :on-run-test="() => {}"
        :on-force-valid="forceValid"
        :on-go-to-model-selection="() => router.push('/settings/modules/consciousness')"
      />
    </ProviderSettingsContainer>
  </ProviderSettingsLayout>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
