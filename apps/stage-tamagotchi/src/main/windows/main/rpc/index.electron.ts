import type { BrowserWindow } from 'electron'

import type { I18n } from '../../../libs/i18n'
import type { WindowAuthManager } from '../../../services/airi/auth'
import type { ServerChannel } from '../../../services/airi/channel-server'
import type { ClaudeCodeManager } from '../../../services/airi/claude-code'
import type { McpStdioManager } from '../../../services/airi/mcp-servers'
import type { AutoUpdater } from '../../../services/electron/auto-updater'
import type { NoticeWindowManager } from '../../notice'
import type { OnboardingWindowManager } from '../../onboarding'
import type { SettingsWindowManager } from '../../settings'
import type { WidgetsWindowManager } from '../../widgets'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { ipcMain } from 'electron'

import { electronOpenChat, electronOpenMainDevtools, electronOpenSettings, noticeWindowEventa } from '../../../../shared/eventa'
import { createAuthService } from '../../../services/airi/auth'
import { createClaudeCodeService } from '../../../services/airi/claude-code/electron-service'
import { createMcpServersService } from '../../../services/airi/mcp-servers'
import { createOnboardingService } from '../../../services/airi/onboarding'
import { createWidgetsService } from '../../../services/airi/widgets'
import { createAutoUpdaterService } from '../../../services/electron'
import { toggleWindowShow } from '../../shared'
import { setupBaseWindowElectronInvokes } from '../../shared/window'

export async function setupMainWindowElectronInvokes(params: {
  window: BrowserWindow
  settingsWindow: SettingsWindowManager
  chatWindow: () => Promise<BrowserWindow>
  widgetsManager: WidgetsWindowManager
  noticeWindow: NoticeWindowManager
  autoUpdater: AutoUpdater
  serverChannel: ServerChannel
  mcpStdioManager: McpStdioManager
  claudeCodeManager: ClaudeCodeManager
  i18n: I18n
  onboardingWindowManager: OnboardingWindowManager
  windowAuthManager: WindowAuthManager
}) {
  // TODO: once we refactored eventa to support window-namespaced contexts,
  // we can remove the setMaxListeners call below since eventa will be able to dispatch and
  // manage events within eventa's context system.
  ipcMain.setMaxListeners(0)

  const { context } = createContext(ipcMain, params.window)

  await setupBaseWindowElectronInvokes({ context, window: params.window, serverChannel: params.serverChannel, i18n: params.i18n })
  createWidgetsService({ context, widgetsManager: params.widgetsManager, window: params.window })
  createAutoUpdaterService({ context, window: params.window, service: params.autoUpdater })
  createMcpServersService({ context, manager: params.mcpStdioManager })
  // The main (stage) window is the chat-sync authority — it runs the chat
  // orchestrator and needs live stream events from the Claude Code runner.
  // Other windows (chat follower, settings) only need the invoke handlers.
  createClaudeCodeService({ context, manager: params.claudeCodeManager, broadcastStreamEvents: true })
  createOnboardingService({ context, onboardingWindowManager: params.onboardingWindowManager })
  createAuthService({ context, window: params.window, windowAuthManager: params.windowAuthManager })

  defineInvokeHandler(context, electronOpenMainDevtools, () => params.window.webContents.openDevTools({ mode: 'detach' }))
  defineInvokeHandler(context, electronOpenSettings, payload => params.settingsWindow.openWindow(payload?.route))
  defineInvokeHandler(context, electronOpenChat, async () => toggleWindowShow(await params.chatWindow()))
  defineInvokeHandler(context, noticeWindowEventa.openWindow, payload => params.noticeWindow.open(payload))
}
