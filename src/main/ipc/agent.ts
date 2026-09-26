/**
 * 内置 agent 的 IPC：UI 按一下 → 起一个隔离的 Pi 会话 → 让模型用 MonoSpace 自己的工具干活。
 *
 * 为什么每次调用新建会话：会话是**一次性**的（无跨次记忆），省掉生命周期管理；工具本身是幂等的
 * 台账操作与页面操作，不需要靠对话历史维持上下文。需要多轮对话时再引入常驻会话。
 */
import { ipcMain } from 'electron'
import { agentPaths, readAgentConfig } from '../agent/config'
import { createAgentLogBuffer } from '../agent/log-buffer'
import { createEmbeddedAgent } from '../agent/session'
import type { McpHost } from '../agent/tools'

export const AGENT_RUN_CHANNEL = 'agent:run'
export const AGENT_STATUS_CHANNEL = 'agent:status'
export const AGENT_LOG_CHANNEL = 'agent:log'
export const AGENT_LOG_CLEAR_CHANNEL = 'agent:log-clear'

/** 面板直接消费的记录形状（定义在纯逻辑模块里）。 */
export type { AgentLogEntry } from '../agent/log-buffer'

/**
 * agent 调试日志（本机排查用）。
 *
 * 隐私/安全：工具参数里可能含密钥明文（`keys_ingest` 的 `code`、`ledger_query` 的状态等）。
 * 这里**仅存内存、不落盘、不写审计**——应用退出即丢；`appendAudit` 是另一条持久化链路，
 * 刻意不接。记录的是「agent 传了什么参数」，不是审计事实。
 */
const agentLog = createAgentLogBuffer()

export interface AgentToolCall {
  name: string
  /** 工具抛错时记 false（适配器约定：失败抛错，不把错误塞进内容）。 */
  ok: boolean
}

export interface AgentRunResult {
  ok: boolean
  /** 模型最终文本（无工具调用时就是回答本身）。 */
  text: string
  toolCalls: AgentToolCall[]
  /** 失败原因（配置缺失、模型报错等）。 */
  message?: string
}

export interface AgentStatus {
  /** 配置是否可用；不可用时 UI 该提示去配置而不是让按钮假装能用。 */
  ready: boolean
  reason?: string
}

/** 配置状态。不建会话，只看落盘配置。 */
export async function agentStatus(userDataDir: string): Promise<AgentStatus> {
  const config = await readAgentConfig(agentPaths(userDataDir))
  return config.ok ? { ready: true } : { ready: false, reason: config.reason }
}

/** 跑一次。失败不抛给渲染进程，给结构化原因。 */
export async function runAgent(options: {
  prompt: string
  userDataDir: string
  host: McpHost
}): Promise<AgentRunResult> {
  const toolCalls: AgentToolCall[] = []
  let text = ''
  let agent: Awaited<ReturnType<typeof createEmbeddedAgent>> | undefined

  agentLog.runStart(options.prompt)
  try {
    agent = await createEmbeddedAgent({ userDataDir: options.userDataDir, host: options.host })
    agent.session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        text += event.assistantMessageEvent.delta
        agentLog.pushTextDelta(event.assistantMessageEvent.delta)
      }
      if (event.type === 'tool_execution_start') {
        toolCalls.push({ name: event.toolName, ok: true })
        agentLog.toolStart({ callId: event.toolCallId, tool: event.toolName, args: event.args })
      }
      if (event.type === 'tool_execution_end') {
        if (event.isError) {
          const last = toolCalls[toolCalls.length - 1]
          if (last && last.name === event.toolName) last.ok = false
        }
        agentLog.toolEnd({
          callId: event.toolCallId,
          tool: event.toolName,
          result: event.result,
          isError: event.isError,
        })
      }
    })
    await agent.session.prompt(options.prompt)
    agentLog.runEnd({ ok: true, detail: text })
    return { ok: true, text, toolCalls }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    agentLog.runEnd({ ok: false, detail: message })
    return { ok: false, text, toolCalls, message }
  } finally {
    agent?.dispose()
  }
}

/** 注册 agent IPC。重复调用安全。`getHost` 惰性取 host（它依赖浏览器窗口是否已就绪）。 */
export function registerAgentIpc(options: { userDataDir: string; getHost: () => McpHost }): void {
  ipcMain.removeHandler(AGENT_RUN_CHANNEL)
  ipcMain.removeHandler(AGENT_STATUS_CHANNEL)
  ipcMain.removeHandler(AGENT_LOG_CHANNEL)
  ipcMain.removeHandler(AGENT_LOG_CLEAR_CHANNEL)
  ipcMain.handle(AGENT_RUN_CHANNEL, (_event, prompt: string) =>
    runAgent({ prompt, userDataDir: options.userDataDir, host: options.getHost() }),
  )
  ipcMain.handle(AGENT_STATUS_CHANNEL, () => agentStatus(options.userDataDir))
  // 最新在前的快照；空数组表示还没跑过（或刚被清空）。
  ipcMain.handle(AGENT_LOG_CHANNEL, () => agentLog.snapshot())
  ipcMain.handle(AGENT_LOG_CLEAR_CHANNEL, () => agentLog.clear())
}
