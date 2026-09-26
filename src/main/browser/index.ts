import { BrowserWindow, ipcMain, type Session } from 'electron'
import { ensureBundledExtensions } from './bundled-extensions'
import { loadStoreExtension, swapStoreExtension } from './extension-host'
import { createStoreSession, getStoreSession } from './store-session'
import { openStoreView } from './store-view'

/** 扩展经 postMessage → bridge preload 上报的事件，按到达顺序累积。 */
const extensionReports: unknown[] = []

/** 上报订阅者（命令通道用它等回执）。 */
const reportListeners = new Set<(payload: unknown) => void>()

/** 订阅扩展上报；返回取消订阅函数。 */
export function onExtensionReport(listener: (payload: unknown) => void): () => void {
  reportListeners.add(listener)
  return () => reportListeners.delete(listener)
}

export function initBrowser(): void {
  ipcMain.on('mono-space:extension-report', (_event, payload) => {
    extensionReports.push(payload)
    for (const listener of reportListeners) listener(payload)
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
  /** 装载内置扩展（验证打包态 resources 路径可解析）。 */
  ensureExtensions(): Promise<void>
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
    ensureExtensions: () => ensureBundledExtensions(getStoreSession()),
    closeAllWindows: () => {
      const windows = BrowserWindow.getAllWindows()
      for (const window of windows) window.destroy()
      return windows.length
    },
  }
  Reflect.set(globalThis, '__monoSpaceTest', hooks)
}
