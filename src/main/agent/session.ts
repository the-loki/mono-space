/**
 * 内置 agent 的引导：把 MonoSpace 自己的工具注入一个**完全隔离**的 Pi 会话。
 *
 * 隔离要点（见 `#31` 反向决策：不再依赖外部 agent）：
 * - `agentDir` 指到 `<userData>/pi-agent`，Pi 的认证 / 模型 / 设置 / 扩展发现全落在我们自己的目录里，
 *   绝不读写 `~/.pi`；
 * - `appendSystemPromptOverride: () => []`，否则 `DefaultResourceLoader` 会把 `~/.pi/agent` 或
 *   `<cwd>/.pi` 里的 `APPEND_SYSTEM.md` 拼进系统提示词——那就漏了；
 * - `cwd` 默认也指向自己的目录，避免读宿主工作区的 `.pi` / `AGENTS.md`；
 * - `noTools: 'builtin'`，关掉 Pi 自带的 read / bash / edit / write（这个应用不需要文件系统手脚，
 *   也不需要它去碰仓库）。
 */
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { agentPaths, readAgentConfig } from './config'
import { adaptTools } from './tool-adapter'
import { createTools, type McpHost } from './tools'

/** 系统提示词。说明作用域与纪律，不夹带任何外部上下文。 */
export const SYSTEM_PROMPT = `你是 MonoSpace 内置的助手。MonoSpace 是本机上一款管理 Humble Bundle 订单与密钥的桌面应用。

你能做两件事：
1. 操作 MonoSpace 内置浏览器里**当前打开的那个页面**（读 DOM、看截图、执行脚本、点击/滚动等）。
2. 查询与维护台账（订单、密钥、统计）。

纪律：
- 浏览器工具只作用于**当前打开的页面**，没有「选择哪个页面」的参数。页面必须先由人在 UI 上打开。
- 优先**直接操作页面**（点页面自己的控件）来获取与变更信息；只有在页面上拿不到时才退回接口。
- 揭示密钥、提交兑换这类**不可逆**动作不交给你执行，它们由人在 UI 上触发。你可以先把页面准备好，
  然后告诉用户该按哪个按钮。
- 一次会话里同步与兑换不会同时开页面：这两个过程互斥。
- 回答用简体中文，简洁、说清依据（来自页面还是来自接口）。`

export interface EmbeddedAgent {
  session: AgentSession
  /** 实际注入给模型的工具（已按层过滤）。 */
  tools: ToolDefinition[]
  /** 释放会话。 */
  dispose: () => void
}

export interface CreateEmbeddedAgentOptions {
  /** 应用私有目录（`app.getPath('userData')`），一切隔离文件都在它下面。 */
  userDataDir: string
  host: McpHost
  /** 默认用自己的配置目录，避免读到宿主工作区里的 `.pi`。 */
  cwd?: string
}

/**
 * 建会话。配置缺失/非法时**直接抛**，把原因带到 UI，而不是等模型调用时才报怪错。
 */
export async function createEmbeddedAgent(
  options: CreateEmbeddedAgentOptions,
): Promise<EmbeddedAgent> {
  const paths = agentPaths(options.userDataDir)
  const config = await readAgentConfig(paths)
  if (!config.ok) throw new Error(`内置 agent 配置不可用：${config.reason}`)

  const cwd = options.cwd ?? paths.agentDir

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: paths.agentDir,
    systemPromptOverride: () => SYSTEM_PROMPT,
    // 关键：不追加外部 APPEND_SYSTEM.md（上面注释里的隔离要点）。
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()

  const tools = adaptTools(createTools(options.host))

  const { session } = await createAgentSession({
    agentDir: paths.agentDir,
    cwd,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    noTools: 'builtin',
    customTools: tools,
  })

  return { session, tools, dispose: () => session.dispose() }
}
