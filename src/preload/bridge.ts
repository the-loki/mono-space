import { ipcRenderer } from 'electron'

/**
 * store 页面的会话级 preload：把扩展 content script 经 `window.postMessage`
 * 上报的数据转成 IPC 事件给主进程。native messaging 在 Electron 不可用
 * （见 docs/verify/16-embedded-browser.md），这是可用通道之一。
 */
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { __monoSpaceExtension?: boolean; payload?: unknown } | null
  if (data && typeof data === 'object' && data.__monoSpaceExtension === true) {
    ipcRenderer.send('mono-space:extension-report', data.payload ?? null)
  }
})
