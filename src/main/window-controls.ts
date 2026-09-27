/**
 * 无边框窗口（`frame: false`）的窗口控制 IPC + 最大化状态广播。
 *
 * 为什么单独一个模块：这三个动作 + 一个状态事件只关窗口本身，与台账 / 同步 / agent 的 IPC
 * 无关；`index.ts` 负责应用装配，不该再塞一份窗口细节（同 `debug-window.ts` 的理由）。
 *
 * **操作发出请求的那个窗口**：`BrowserWindow.fromWebContents(event.sender)`，不写死主窗口
 * —— 调试窗口与主窗口共用同一套 preload / 通道，写死会让调试窗口的关闭按钮关掉主窗口。
 */
import { app, BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron'

/** 最大化状态变化事件（主进程 → 渲染层）。 */
const MAXIMIZED_CHANGED = 'window:maximized-changed'

/** 取发起请求的窗口；窗口已销毁 / 找不到时为 null。 */
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/** 注册窗口控制通道与状态广播。app ready 后调用一次。 */
export function registerWindowControlIpc(): void {
  ipcMain.handle('window:minimize', (event) => {
    senderWindow(event)?.minimize()
  })

  ipcMain.handle('window:toggle-maximize', (event) => {
    const window = senderWindow(event)
    if (!window) return false
    if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }
    return window.isMaximized()
  })

  ipcMain.handle('window:close', (event) => {
    senderWindow(event)?.close()
  })

  ipcMain.handle('window:is-maximized', (event) => senderWindow(event)?.isMaximized() ?? false)

  // 所有窗口统一挂：标题栏图标要跟着 **窗口管理器** 的状态走 ——
  // 双击标题栏 / 快捷键 / WM 自己最大化都能同步，而不是只反映我们自己点的那一下。
  // 用 app 级事件而不是逐个窗口挂，是为了「新建窗口自动带上」，不再漏挂。
  app.on('browser-window-created', (_event, window) => {
    const notify = (maximized: boolean): void => {
      if (!window.isDestroyed()) window.webContents.send(MAXIMIZED_CHANGED, maximized)
    }
    window.on('maximize', () => notify(true))
    window.on('unmaximize', () => notify(false))
  })
}
