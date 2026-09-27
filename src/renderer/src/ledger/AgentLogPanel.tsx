/**
 * 内置 agent 调试日志面板 —— **调试窗口的整个内容**（用户决策：面板独立成自己的窗口，
 * 不再嵌在台账页里）。
 *
 * 为什么需要它：界面原先只有一行结果提示，agent 传给工具的参数完全看不见——实测漏传必填参数后
 * 事后无从查证。这里把主进程内存里的日志快照展示出来，供本机排查。
 *
 * **自给自足**：运行状态从 `agent:log` 的返回值里读（主进程缓冲的 `isRunning`），所以本组件
 * 不接任何外部 props —— 独立窗口里没有台账页的 `agentRunning` 可传，让面板自己判断才真的独立。
 * 轮询语义：展开时拉一次；运行中每 2.5s 补拉一次；由运行中变不运行时补拉一次最终状态。
 * 数据只在主进程内存，本面板不参与持久化与审计链路（见 `src/main/ipc/agent.ts` 的说明）。
 */
import { type JSX, useCallback, useEffect, useState } from 'react'
import type { AgentLogEntry, AgentLogSnapshot } from './types'

/** 刷新间隔：够看到运行过程，又不会高频空转。 */
const POLL_INTERVAL_MS = 2500

/** 类别 → 中文标签。 */
const KIND_LABELS: Record<AgentLogEntry['kind'], string> = {
  run_start: '开始',
  run_end: '结束',
  turn_text: '文本',
  tool: '工具',
}

/** ISO 时间戳只显示到秒：日志只活在本次进程内，日期无意义，面板也窄。 */
function shortTime(at: string): string {
  return at.length >= 19 ? at.slice(11, 19) : at
}

/** 可折叠的 agent 调试日志面板；默认展开（它就是调试窗口里唯一的内容）。 */
export function AgentLogPanel(): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const [snapshot, setSnapshot] = useState<AgentLogSnapshot>({ entries: [], running: false })
  const [error, setError] = useState('')

  const { entries, running } = snapshot

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await window.api.agent.log())
      setError('')
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // 展开时拉一次；运行中每 2.5s 补拉；running 由 true 变 false 时本 effect 重跑 → 补拉最终状态。
  useEffect(() => {
    if (!expanded) return
    void refresh()
    if (!running) return
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [expanded, running, refresh])

  const handleClear = useCallback(async () => {
    try {
      await window.api.agent.clearLog()
      await refresh()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [refresh])

  return (
    <div
      data-testid="ledger-agent-log"
      className="flex min-h-0 flex-1 flex-col rounded border border-slate-800 bg-slate-900/40"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          data-testid="ledger-agent-log-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="text-slate-300 text-sm hover:text-slate-100"
        >
          {expanded ? '▾' : '▸'} agent 调试日志
          <span data-testid="ledger-agent-log-count" className="ml-1 text-slate-500">
            {entries.length}
          </span>
        </button>
        {running && (
          <span data-testid="ledger-agent-log-running" className="text-emerald-400 text-xs">
            运行中…
          </span>
        )}
        {expanded && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              data-testid="ledger-agent-log-refresh"
              onClick={() => void refresh()}
              className="rounded bg-slate-800 px-2 py-0.5 text-slate-300 text-xs hover:bg-slate-700"
            >
              刷新
            </button>
            <button
              type="button"
              data-testid="ledger-agent-log-clear"
              onClick={() => void handleClear()}
              className="rounded bg-slate-800 px-2 py-0.5 text-slate-300 text-xs hover:bg-slate-700"
            >
              清空
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div
          data-testid="ledger-agent-log-list"
          className="min-h-0 flex-1 overflow-y-auto border-slate-800 border-t px-3 py-2"
        >
          {error && (
            <p data-testid="ledger-agent-log-error" className="text-red-400 text-xs">
              日志读取失败：{error}
            </p>
          )}

          {!error && entries.length === 0 && (
            <p data-testid="ledger-agent-log-empty" className="text-slate-500 text-xs">
              暂无记录。
            </p>
          )}

          <ul className="flex flex-col gap-1">
            {entries.map((entry) => (
              <li
                key={entry.seq}
                data-testid="ledger-agent-log-item"
                data-kind={entry.kind}
                data-failed={entry.failed}
                className={entry.failed ? 'text-red-300 text-xs' : 'text-slate-300 text-xs'}
              >
                <span className="text-slate-500">{shortTime(entry.at)}</span>{' '}
                <span className="text-slate-400">{KIND_LABELS[entry.kind]}</span>
                {entry.tool && <span className="ml-1 text-indigo-300">{entry.tool}</span>}
                {entry.failed && <span className="ml-1 text-red-400">失败</span>}
                {entry.detail && (
                  <div className="break-all font-mono text-slate-400">{entry.detail}</div>
                )}
                {entry.result !== undefined && (
                  <div className="break-all font-mono text-slate-500">→ {entry.result}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
