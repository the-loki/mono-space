import { ipcRenderer } from 'electron'

/**
 * store 页面的会话级 preload：把扩展 content script 的**上报**转成 IPC 给主进程。
 *
 * 通道：content script `window.postMessage({__monoSpaceExtension:true})` → 这里 → IPC
 * `mono-space:extension-report` → `src/main/browser/index.ts` 累积（a11y/DOM 旁证）。
 *
 * native messaging 在 Electron 不可用（见 `docs/verify/16-embedded-browser.md`），
 * 这是实测可用通道（`#24`）。
 *
 * **曾经还有一条下行**（主进程 `mono-space:extension-command` → postMessage 进页面），
 * 随「移除自带扩展 + 移除 MCP」一起废掉了：主进程无人发、页内也无人听（生产里不再打包扩展，
 * 扩展只剩 `tests/fixtures/extension-mv3*` 这个测试夹具，而它只上报、不接收命令）。
 * 按「全仓零引用才算死代码」的判据删掉 —— 留着会让人以为存在一条能命令页面的通道
 * （`docs/verify/33-full-test.md` §0 问题 3）。
 */
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { __monoSpaceExtension?: boolean; payload?: unknown } | null
  if (data && typeof data === 'object' && data.__monoSpaceExtension === true) {
    ipcRenderer.send('mono-space:extension-report', data.payload ?? null)
  }
})
