/**
 * 调试窗口的渲染入口（用户决策：调试面板独立成自己的窗口）。
 *
 * 这里**只挂面板**：没有 header、没有订单页——台账页是另一个入口（`main.tsx`），
 * 两者唯一的共享物是同一个 preload 给出的 `window.api`。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './assets/main.css'
import { AgentLogPanel } from './ledger/AgentLogPanel'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <div className="flex h-screen flex-col bg-slate-950 p-3 text-slate-100">
      <AgentLogPanel />
    </div>
  </StrictMode>,
)
