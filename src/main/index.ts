import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'
import { initBrowser } from './browser'
import { registerLedgerIpc } from './ipc/ledger'
import { registerSyncIpc } from './ipc/sync'
import { registerTaskIpc } from './ipc/tasks'
import { createMcpHost } from './mcp/host'
import { startMcpServer } from './mcp/server'

// 主进程是 ESM（package.json "type":"module"），没有 __dirname，需自行推导。
const currentDir = dirname(fileURLToPath(import.meta.url))

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    title: 'MonoSpace',
    webPreferences: {
      // preload 产物是 .cjs（见 electron.vite.config.ts），在 sandbox 下加载。
      preload: join(currentDir, '../preload/index.cjs'),
      sandbox: true,
    },
  })

  window.on('ready-to-show', () => window.show())

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(currentDir, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(() => {
  // 最小连通性探针：证明 ESM 主进程 ↔ sandboxed preload ↔ 渲染进程的往返成立。
  ipcMain.handle('ping', (_event, message: string) => `pong:${message}`)

  // store 侧的会话、client hints 与扩展桥（见 docs/adr/0002、#24）。
  initBrowser()

  // 台账列表 / 计数 / 导出（见 #23；列表不含兑换码明文）。
  registerLedgerIpc()

  // 只读同步（见 #28：验收发现同步缺入口）。
  registerSyncIpc()

  // 单条揭示 / 兑换动作（见 #25 / #26）。
  registerTaskIpc()

  // MonoSpace 开放 MCP 服务（见 #31）：外部 agent 用它操作内置浏览器 / 分析台账 / 入库。
  void startMcpServer({ host: createMcpHost(), userDataDir: app.getPath('userData') })
    .then((running) => {
      // 端点（含 token）只写应用私有文件（0600），控制台只提示位置，不打印 token。
      console.log(`MonoSpace MCP 已启动：${running.endpoint.url.replace(/token=.*/, 'token=***')}`)
      console.log(`端点文件：${running.endpoint.file}`)
    })
    .catch((error: unknown) => {
      console.error('MonoSpace MCP 启动失败：', error instanceof Error ? error.message : error)
    })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
