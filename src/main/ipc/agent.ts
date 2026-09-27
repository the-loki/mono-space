/**
 * 内置 agent 的 IPC：UI 按一下 → 起一个隔离的 Pi 会话 → 让模型用 MonoSpace 自己的工具干活。
 *
 * 为什么每次调用新建会话：会话是**一次性**的（无跨次记忆），省掉生命周期管理；工具本身是幂等的
 * 台账操作与页面操作，不需要靠对话历史维持上下文。需要多轮对话时再引入常驻会话。
 */
import { ipcMain } from 'electron'
import type { AgentRunResult, AgentStatus, AgentToolCall } from '../../shared/ipc-contract'
import { agentPaths, readAgentConfig } from '../agent/config'
import { createAgentLogBuffer } from '../agent/log-buffer'
import { readOrderKeysPrompt, revealKeyPrompt } from '../agent/prompts'
import { createEmbeddedAgent } from '../agent/session'
import type { McpHost } from '../agent/tools'

// 内置任务：提示词与输出 schema 都在主进程侧，渲染层只传标识（gamekey / keyId）。
export const AGENT_READ_ORDER_KEYS_CHANNEL = 'agent:read-order-keys'
export const AGENT_REVEAL_KEY_CHANNEL = 'agent:reveal-key'
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

/** 这三个形状也过 IPC（渲染层读 `window.api.agent`），所以放在共享契约里。 */
export type { AgentRunResult, AgentStatus, AgentToolCall }

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
  ipcMain.removeHandler(AGENT_READ_ORDER_KEYS_CHANNEL)
  ipcMain.removeHandler(AGENT_REVEAL_KEY_CHANNEL)
  ipcMain.removeHandler(AGENT_STATUS_CHANNEL)
  ipcMain.removeHandler(AGENT_LOG_CHANNEL)
  ipcMain.removeHandler(AGENT_LOG_CLEAR_CHANNEL)
  // 按订单读 key：渲染层只传 gamekey，提示词在这里拼。
  ipcMain.handle(AGENT_READ_ORDER_KEYS_CHANNEL, (_event, gamekey: string) =>
    runAgent({
      prompt: readOrderKeysPrompt(gamekey),
      userDataDir: options.userDataDir,
      host: options.getHost(),
    }),
  )
  // 揭示单条 key：同样只传 keyId。
  ipcMain.handle(AGENT_REVEAL_KEY_CHANNEL, (_event, keyId: number) =>
    runAgent({
      prompt: revealKeyPrompt(keyId),
      userDataDir: options.userDataDir,
      host: options.getHost(),
    }),
  )
  ipcMain.handle(AGENT_STATUS_CHANNEL, () => agentStatus(options.userDataDir))
  // 调试日志快照：记录（最新在前，空数组表示没跑过或刚被清空）+ 是否正在运行。
  // 运行状态一起给出去，面板才能自给自足地在独立窗口里决定要不要低频轮询。
  ipcMain.handle(AGENT_LOG_CHANNEL, () => ({
    entries: agentLog.snapshot(),
    running: agentLog.isRunning(),
  }))
  ipcMain.handle(AGENT_LOG_CLEAR_CHANNEL, () => agentLog.clear())
}
