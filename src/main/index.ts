import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createMcpHost } from './agent/host'
import { initBrowser } from './browser'
import { registerAgentIpc } from './ipc/agent'
import { registerDebugIpc } from './ipc/debug'
import { registerLedgerIpc } from './ipc/ledger'
import { registerSyncIpc } from './ipc/sync'
import { registerTaskIpc } from './ipc/tasks'
import { registerWindowControlIpc } from './window-controls'

// 主进程是 ESM（package.json "type":"module"），没有 __dirname，需自行推导。
const currentDir = dirname(fileURLToPath(import.meta.url))

/**
 * 应用图标路径。
 *
 * 两条路径的原因：dev 下应用目录就是仓库（`out/main` 往上两级）；打包后 `build/` 不在 asar 里，
 * 而是在 `resources/`（见 electron-builder.yml 的 extraResources）。
 * 不设这个图标时打包日志会写 `default Electron icon is used reason=application icon is not set`
 * （`docs/verify/33` §0 记过的缺口）。产图脚本：`scripts/make-icon.py`。
 */
function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(currentDir, '../../build/icon.png')
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    title: 'MonoSpace',
    // 窗口/任务栏图标。dev 从仓库读；打包后读 `resources/icon.png`（electron-builder 的 extraResources）。
    icon: appIconPath(),
    // 无边框（用户决策：不要系统 title bar）。Linux 不支持 macOS/Windows 的 titleBarStyle 那套，
    // 只能 frame: false；标题栏改由渲染层自建（见 src/renderer/src/ui/TitleBar.tsx）。
    frame: false,
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

// 无条件禁用硬件加速（必须在 app ready **之前**，晚了 Chromium 已经初始化）。
//
// 为什么不是「先崩一次再降级」：本机 GPU 进程**根本起不来**，每次启动都是
//   GPU process launch failed: error_code=1002
//   FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.
// 然后直接退出（对「装完即启动」是硬伤：双击图标窗口压根不出来）。
// 原先写了哨兵式的崩溃恢复，但既然这台机器每次都崩，那层优雅就是多余的开销：
// 直接软件渲染，界面是普通列表/表单，代价无感。
app.commandLine.appendSwitch('disable-gpu')

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

  // 内置 agent（用户决策：不再依赖外部 agent，MCP 关掉；工具注入自带 Pi）。
  // host 惰性创建：它依赖浏览器窗口，首次调用时才建（见 createMcpHost 内部缓存）。
  registerAgentIpc({
    userDataDir: app.getPath('userData'),
    getHost: createMcpHost,
  })

  // 调试面板独立窗口（用户决策）：`debug:open` 幂等开窗 / 聚焦（见 debug-window.ts）。
  registerDebugIpc()

  // 无边框窗口的控制通道（最小化 / 最大化 / 关闭 + 状态广播，见 window-controls.ts）。
  // 必须在任何 BrowserWindow **创建之前**注册：状态广播挂在 app 的 browser-window-created 上。
  registerWindowControlIpc()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
