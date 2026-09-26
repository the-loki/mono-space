/**
 * MonoSpace 的 MCP 工具面（`#31`）。
 *
 * 命名规则（用户要求，避免与其它浏览器 MCP 冲突）：
 * - **所有工具一律 `monospace_` 前缀**；浏览器类再带 `browser` 段（如 `monospace_browser_goto`）。
 * - 每个带浏览器语义的工具，描述里都写明：操作的是 **MonoSpace 应用内置的浏览会话**
 *   （登录态在应用私有分区 `persist:store`），**不是**系统 Chrome 或其它浏览器 MCP 的页面。
 *
 * 权限分层沿用 `#13`：只读自动放行；写入自动但留痕；不可逆写入必须人在环路。
 */
import { z } from 'zod'
import type { BrowserHost } from './host-contract'
import { createBrowserTools } from './tools-browser'

/** L0 只读：台账统计。 */
export interface LedgerStats {
  total: number
  unrevealed: number
  revealedUnredeemed: number
  redeemed: number
  byEngine: Record<string, number>
}

/** 台账列表项（**不含兑换码明文**，`#14` §5）。 */
export interface LedgerRow {
  keyId: number
  name: string | null
  bundle: string | null
  order: string | null
  engine: string
  revealStatus: string
  redeemStatus: string
}

/** 写入结果（含留痕）。 */
export interface UpsertResult {
  written: number
  auditId: string
}

/** 浏览器导航结果。 */
export interface BrowserNavResult {
  url: string
  title: string
  /** did-navigate 的 HTTP 状态（或 -1）。 */
  status: number
}

/** 动作结果（揭示/兑换：可能停在人在环路）。 */
export interface ActionOutcome {
  status: string
  pause?: string
  code?: string
  attempts: number
  note: string
}

/** `keys_upsert` 的单条输入。 */
export interface KeyUpsertEntry {
  keyId: number
  /** 从页面读到的兑换码（可选；有则写）。 */
  code?: string | null
  /** 从页面读到的揭示状态。 */
  revealed?: boolean
  note?: string
}

/**
 * 工具背后的宿主。全部由主进程实现（持有 store 会话与台账）。
 * 浏览器能力来自 `host-contract.ts` 的 `BrowserHost`（Chrome MCP 的忠实镜像）。
 */
export interface McpHost extends BrowserHost {
  ledgerStats(): Promise<LedgerStats>
  ledgerQuery(input: {
    view?: string
    engine?: string
    limit?: number
    offset?: number
  }): Promise<LedgerRow[]>
  keyContext(keyId: number): Promise<(LedgerRow & { redeemCode?: string | null }) | null>
  ordersSync(): Promise<unknown>
  keysUpsert(entries: KeyUpsertEntry[]): Promise<UpsertResult>
  keyReveal(keyId: number): Promise<ActionOutcome>
  keyRedeem(keyId: number): Promise<ActionOutcome>
}

/** 一个工具的定义：MCP 注册所需的最小信息。 */
export interface McpToolSpec {
  name: string
  title: string
  description: string
  /** 只读 / 写入 / 不可逆（用于权限分层与审计）。 */
  layer: 'L0' | 'L1' | 'L2'
  inputSchema: z.ZodRawShape
  run(input: Record<string, unknown>): Promise<unknown>
}

/** 所有工具的统一前缀（防与其它 MCP 撞名）。 */
export const TOOL_PREFIX = 'monospace_'

/**
 * 所有工具描述的统一前缀。为什么要有它：真实环境里 agent 往往同时挂着
 * Chrome DevTools MCP / Playwright MCP，它们的 `click` / `take_snapshot` 与我们的
 * 同名同义但**操作对象完全不同**——一眼可辨比事后解释便宜得多。
 */
export const MONOSPACE_TAG = '【MonoSpace】'

/** 浏览器类工具描述里统一加上这句：说清作用域，并**点名**最容易混淆的那些 MCP。 */
export const BROWSER_SCOPE =
  '作用范围：**MonoSpace 应用内置的浏览会话**（页面在应用私有分区，登录态只属于本应用）。' +
  '**这不是系统 Chrome，也不是 Chrome DevTools MCP / Playwright MCP / Puppeteer 等浏览器 MCP 的页面**——' +
  '操作对象完全不同，不要把它们的目标与这里的目标混用。'

/** 建全部工具（出口处统一补 `【MonoSpace】` 前缀，保证没有漏网的）。 */
export function createMcpTools(host: McpHost): McpToolSpec[] {
  return [...createDomainTools(host), ...createBrowserTools(host)].map((spec) => ({
    ...spec,
    description: spec.description.includes(MONOSPACE_TAG)
      ? spec.description
      : `${MONOSPACE_TAG} ${spec.description}`,
  }))
}

/** 领域工具（MonoSpace 自己的台账 / 同步 / 揭示 / 兑换）。 */
function createDomainTools(host: McpHost): McpToolSpec[] {
  return [
    {
      name: `${TOOL_PREFIX}ledger_stats`,
      title: 'MonoSpace 台账统计',
      description:
        '统计 MonoSpace 台账：总数与「未揭示 / 已揭示未兑换 / 已兑换」分布、各引擎数量。只读。',
      layer: 'L0',
      inputSchema: {},
      run: () => host.ledgerStats(),
    },
    {
      name: `${TOOL_PREFIX}ledger_query`,
      title: 'MonoSpace 台账查询',
      description:
        '分页查询 MonoSpace 台账列表（资产名 / 包 / 订单 / 引擎 / 揭示与兑换状态）。**不含兑换码明文**；要码请用 key_context。只读。',
      layer: 'L0',
      inputSchema: {
        view: z.enum(['all', 'unrevealed', 'revealed_unredeemed', 'redeemed']).optional(),
        engine: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
      run: (input) =>
        host.ledgerQuery({
          view: input.view as string | undefined,
          engine: input.engine as string | undefined,
          limit: input.limit as number | undefined,
          offset: input.offset as number | undefined,
        }),
    },
    {
      name: `${TOOL_PREFIX}key_context`,
      title: 'MonoSpace 单条 key 上下文',
      description:
        '查 MonoSpace 台账里某条 key 的上下文（名称/包/订单/引擎/揭示与兑换状态）。**仅当 includeCode=true 时才返回兑换码明文**，且此调用会留痕。',
      layer: 'L0',
      inputSchema: {
        keyId: z.number().int().positive(),
        includeCode: z.boolean().optional(),
      },
      run: async (input) => {
        const context = await host.keyContext(input.keyId as number)
        if (!context) return { found: false, message: `台账里没有 keyId=${input.keyId}` }
        if (input.includeCode !== true) {
          const { redeemCode: _omitted, ...rest } = context
          return { found: true, key: rest, note: '兑换码未返回（未传 includeCode=true）' }
        }
        return { found: true, key: context }
      },
    },
    {
      name: `${TOOL_PREFIX}orders_sync`,
      title: 'MonoSpace 同步订单（接口）',
      description:
        '让 MonoSpace 通过 **Humble 接口**跑一次只读同步：拉取订单列表与详情，增量写入台账（订单 → 引擎资产包 → key）。写入类，会留痕。',
      layer: 'L1',
      inputSchema: {},
      run: () => host.ordersSync(),
    },
    {
      name: `${TOOL_PREFIX}keys_upsert`,
      title: 'MonoSpace 回写 key 读取结果',
      description:
        '把外部 agent 从页面上读到的 key 信息（揭示状态 / 兑换码）写回 MonoSpace 台账。写入类，**强制留痕**。',
      layer: 'L1',
      inputSchema: {
        entries: z
          .array(
            z.object({
              keyId: z.number().int().positive(),
              code: z.string().nullable().optional(),
              revealed: z.boolean().optional(),
              note: z.string().optional(),
            }),
          )
          .min(1)
          .max(500),
      },
      run: (input) => host.keysUpsert(input.entries as KeyUpsertEntry[]),
    },
    {
      name: `${TOOL_PREFIX}key_reveal`,
      title: 'MonoSpace 揭示某个 key（不可逆）',
      description:
        '让 MonoSpace 执行一次**揭示**（Humble，不可逆写操作）。会打开可见窗口；如需登录/reCAPTCHA，会停在**人在环路**并把 pause 原因回给你。',
      layer: 'L2',
      inputSchema: { keyId: z.number().int().positive() },
      run: (input) => host.keyReveal(input.keyId as number),
    },
    {
      name: `${TOOL_PREFIX}key_redeem`,
      title: 'MonoSpace 兑换某个 key（不可逆）',
      description:
        '让 MonoSpace 执行一次**兑换**（Epic 兑换页 + My Library 校验）。会打开可见窗口；如需登录/验证码/条款确认，会停在**人在环路**并把 pause 原因回给你。',
      layer: 'L2',
      inputSchema: { keyId: z.number().int().positive() },
      run: (input) => host.keyRedeem(input.keyId as number),
    },
  ]
}
