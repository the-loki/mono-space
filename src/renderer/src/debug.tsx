/**
 * 调试窗口的渲染入口（用户决策：调试面板独立成自己的窗口）。
 *
 * 这里**只挂面板**：没有订单页——台账页是另一个入口（`main.tsx`），
 * 两者唯一的共享物是同一个 preload 给出的 `window.api`。
 * 窗口本身是无边框的（见 main/debug-window.ts），所以同样要自建标题栏：
 * 与主窗口用同一个 `TitleBar`，只是没有最大化按钮（工具窗不需要）。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './assets/main.css'
import { AgentLogPanel } from './ledger/AgentLogPanel'
import { TitleBar } from './ui/TitleBar'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <div className="flex h-screen flex-col bg-canvas text-ink text-sm">
      <TitleBar showMaximize={false}>
        <span className="font-medium text-ink text-xs">MonoSpace 调试日志</span>
      </TitleBar>
      <div className="flex min-h-0 flex-1 flex-col">
        <AgentLogPanel />
      </div>
    </div>
  </StrictMode>,
)
