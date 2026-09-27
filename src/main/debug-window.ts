/**
 * 调试日志的**独立窗口**（用户决策：面板不再嵌在台账页里，改成自己的窗口，可拖动 / 常驻）。
 *
 * 为什么单独一个模块：`index.ts` 负责应用装配，不该再塞一份窗口生命周期；这里只管「开一个、
 * 已开就聚焦」。preload 与加载方式跟 `createWindow` 完全一致（同一个 `preload/index.cjs`，
 * 开发态走 `ELECTRON_RENDERER_URL`、生产态走构建产物里的 html），调试窗口因此拿到同一套
 * `window.api`（否则面板读不到 `agent:log`）。
 *
 * 隐私：窗口只读主进程内存里的日志（不落盘、不写审计，见 `src/main/ipc/agent.ts`）。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow } from 'electron'

// 主进程是 ESM，没有 __dirname（同 index.ts）。
const currentDir = dirname(fileURLToPath(import.meta.url))

/** 单实例：当前调试窗口（被关掉后 `isDestroyed()` 为真，下次调用重开）。 */
let debugWindow: BrowserWindow | null = null

/**
 * 开调试窗口。**幂等**：已开则只聚焦（重复点按钮 / 重复调 IPC 不会开出一堆窗口）。
 */
export function openDebugWindow(): BrowserWindow {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.focus()
    return debugWindow
  }

  const window = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 480,
    minHeight: 320,
    show: false,
    title: 'MonoSpace 调试日志',
    webPreferences: {
      preload: join(currentDir, '../preload/index.cjs'),
      sandbox: true,
    },
  })

  window.on('ready-to-show', () => window.show())

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void window.loadURL(`${rendererUrl}/debug.html`)
  } else {
    void window.loadFile(join(currentDir, '../renderer/debug.html'))
  }

  debugWindow = window
  return window
}
