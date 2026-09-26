import { BrowserWindow, ipcMain, type Session } from 'electron'
import { loadStoreExtension, swapStoreExtension } from './extension-host'
import { createStoreSession } from './store-session'
import { openStoreView } from './store-view'

/** 扩展经 postMessage → bridge preload 上报的事件，按到达顺序累积。 */
const extensionReports: unknown[] = []

export function initBrowser(): void {
  ipcMain.on('mono-space:extension-report', (_event, payload) => {
    extensionReports.push(payload)
  })

  if (process.env.MS_TEST === '1') installTestHooks()
}

export interface TestHooks {
  reports(): unknown[]
  openStoreView(
    url: string,
    options?: { partition?: string; urls?: string[]; show?: boolean },
  ): ReturnType<typeof openStoreView>
  loadExtension(extensionPath: string, partition?: string): ReturnType<typeof loadStoreExtension>
  swapExtension(
    extensionId: string,
    extensionPath: string,
    partition?: string,
  ): ReturnType<typeof swapStoreExtension>
  closeAllWindows(): number
}

function installTestHooks(): void {
  const hooks: TestHooks = {
    reports: () => [...extensionReports],
    openStoreView: (url, options = {}) => {
      const storeSession: Session = createStoreSession({
        partition: options.partition,
        urls: options.urls,
      })
      return openStoreView(storeSession, url, { show: options.show ?? false })
    },
    loadExtension: (extensionPath, partition) =>
      loadStoreExtension(createStoreSession({ partition }), extensionPath),
    swapExtension: (extensionId, extensionPath, partition) =>
      swapStoreExtension(createStoreSession({ partition }), extensionId, extensionPath),
    closeAllWindows: () => {
      const windows = BrowserWindow.getAllWindows()
      for (const window of windows) window.destroy()
      return windows.length
    },
  }
  Reflect.set(globalThis, '__monoSpaceTest', hooks)
}
