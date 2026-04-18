import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'apps/server',
      'packages/agent-runtime',
      'packages/cron-runtime',
      'apps/ui-server-auth',
      'apps/stage-tamagotchi',
      'packages/audio-pipelines-transcribe',
      'packages/cap-vite',
      'packages/vishot-runner-browser',
      'packages/plugin-sdk',
      'packages/server-runtime',
      'packages/server-sdk',
      'packages/skill-registry',
      'packages/stage-shared',
      'packages/stage-ui',
      'packages/stage-ui-live2d',
      'packages/vishot-runtime',
      'packages/vite-plugin-warpdrive',
    ],
  },
})
