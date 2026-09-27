/**
 * 调试面板独立窗口的 IPC。
 *
 * 契约：`debug:open` -> void。**幂等**由开窗侧保证（已开则聚焦，见 `src/main/debug-window.ts`），
 * 所以渲染层随便点都不怕。
 */
import { ipcMain } from 'electron'
import { openDebugWindow } from '../debug-window'

export const DEBUG_OPEN_CHANNEL = 'debug:open'

/** 注册调试窗口 IPC。重复调用安全。 */
export function registerDebugIpc(): void {
  ipcMain.removeHandler(DEBUG_OPEN_CHANNEL)
  ipcMain.handle(DEBUG_OPEN_CHANNEL, () => {
    openDebugWindow()
  })
}
