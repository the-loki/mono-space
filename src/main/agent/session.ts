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
- 浏览器工具只作用于**当前打开的页面**，没有「选择哪个页面」的参数。
  如果一个页面都没打开，**用 monospace_page_open 自己打开一张**（这就是你的起点，不需要等人先开）。
- 优先**直接操作页面**（点页面自己的控件）来获取与变更信息；只有在页面上拿不到时才退回接口。
- **揭示密钥由你在页面上完成**（特征匹配已删除，全权交给你）：
  用 monospace_key_open(keyId) 打开那一单的订单页 → monospace_dom 看清页面 →
  用 monospace_act(click) 点页面**自己的**揭示控件（未揭示时文字为「显示您的 … 密钥」）→
  从页面读出密钥 → 用 monospace_keys_upsert 写回台账。
  这是**不可逆**动作：**只点一次**。页面上认不出控件、或点完读不到码时，停下来告诉用户，
  **绝不猜着点**、也**绝不重放点击**。
- 提交兑换暂时仍由人在 UI 上触发。
- 一次会话里同步与兑换不会同时开页面：这两个过程互斥。
- **只用简体中文作答，一个英文词都不要出现**（包括开头那句「我准备做什么」的计划说明）。
  不要把思考过程或计划念出来：直接调用工具、直接给结论。
- 简洁、说清依据（来自页面还是来自接口）。`

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
