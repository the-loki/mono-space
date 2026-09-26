import { ipcRenderer } from 'electron'

/**
 * store 页面的会话级 preload，双向通道：
 * - 上行：扩展 content script 经 `window.postMessage({__monoSpaceExtension:true})`
 *   上报 → IPC 给主进程；
 * - 下行：主进程 `mono-space:extension-command` → 再 postMessage 进页面给 content script。
 *
 * native messaging 在 Electron 不可用（见 docs/verify/16-embedded-browser.md），
 * 这是实测可用通道（`#24`）。
 */
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { __monoSpaceExtension?: boolean; payload?: unknown } | null
  if (data && typeof data === 'object' && data.__monoSpaceExtension === true) {
    ipcRenderer.send('mono-space:extension-report', data.payload ?? null)
  }
})

ipcRenderer.on('mono-space:extension-command', (_event, command: unknown) => {
  window.postMessage({ __monoSpaceCommand: true, command }, '*')
})
