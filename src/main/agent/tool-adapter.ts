/**
 * 把 MonoSpace 自己的工具表（`ToolSpec[]`）适配成 Pi SDK 的 `ToolDefinition[]`。
 *
 * 为什么需要这一层：工具表是**唯一事实来源**（原先供 MCP 服务用，现在改为注入内置 agent），
 * 两个消费者只是形状不同——所以只做形状转换，绝不在两边各维护一份工具清单。
 */
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ToolSpec } from './tools'

/**
 * 不交给模型的层。
 *
 * 揭示 / 兑换是**不可逆**动作（`#25` / `#26` 的状态机也按此设计），而在内核里跑着的 agent
 * 循环没有「停下来问人」的通道。所以这一层只走 UI 按钮，由人按；给模型等于让它自己把
 * 密钥揭示掉。要放开必须先有确认通道（见票 #27 遗留项）。
 */
export const AGENT_DENIED_LAYERS = ['L2'] as const

/** 工具返回值就是 MCP 的 content 块（截图会返回 image 块），不要当 JSON 再包一层。 */
export function isToolContent(value: unknown): value is AgentToolResult<unknown> {
  if (typeof value !== 'object' || value === null) return false
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every((block) => {
    if (typeof block !== 'object' || block === null) return false
    const type = (block as { type?: unknown }).type
    return type === 'text' || type === 'image'
  })
}

/** 任意返回值 → agent 能看的结果。 */
export function toToolResult(value: unknown): AgentToolResult<unknown> {
  if (isToolContent(value)) return { content: value.content, details: undefined }
  if (typeof value === 'string')
    return { content: [{ type: 'text', text: value }], details: undefined }
  // 兜底：结构化数据序列化成文本（模型读 JSON 文本比读 [object Object] 强）。
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details: undefined }
}

/** 单个工具的适配。 */
export function toPiTool(spec: ToolSpec): ToolDefinition {
  return {
    name: spec.name,
    label: spec.title,
    description: spec.description,
    parameters: spec.parameters,
    // 失败**抛错**（SDK 约定：不要把错误编码进 content），让 agent 看到真实原因并自行改道。
    execute: async (_toolCallId, params) =>
      toToolResult(await spec.run(params as Record<string, unknown>)),
  }
}

export interface AdaptToolsOptions {
  /** 额外允许/禁止的层；默认按 {@link AGENT_DENIED_LAYERS} 挡掉 L2。 */
  deniedLayers?: readonly string[]
}

/**
 * 工具表 → Pi 工具。
 *
 * 按层过滤是这里唯一的策略判断；不额外发明限流、关键词拦截、域名白名单之类的门（用户明确
 * 反对），约束只有两条：命名带 MonoSpace 前缀（在工具表里）+ 作用域只针对当前打开的页面。
 */
export function adaptTools(
  specs: readonly ToolSpec[],
  options: AdaptToolsOptions = {},
): ToolDefinition[] {
  const denied = new Set<string>(options.deniedLayers ?? AGENT_DENIED_LAYERS)
  return specs.filter((spec) => !denied.has(spec.layer)).map(toPiTool)
}
