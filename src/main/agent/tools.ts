/**
 * MonoSpace 的工具面（`#31`）：不再走 MCP，由主进程注入内置 Pi agent。
 *
 * 命名规则（用户要求，避免与其它浏览器 MCP 冲突）：
 * - **所有工具一律 `monospace_` 前缀**；浏览器类再带 `browser` 段（如 `monospace_browser_goto`）。
 * - 每个带浏览器语义的工具，描述里都写明：操作的是 **MonoSpace 应用内置的浏览会话**
 *   （登录态在应用私有分区 `persist:store`），**不是**系统 Chrome 或其它浏览器 MCP 的页面。
 *
 * 权限分层沿用 `#13`：只读自动放行；写入自动但留痕；不可逆写入必须人在环路。
 */
import { type TObject, Type } from 'typebox'
import type { PageOrderRead } from '../data/page-ingest'
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
  /** 把 agent 从订单页**读到**的资产与密钥落库（ADR-0003：key 与资产包只从页面读取）。 */
  keysIngest(read: PageOrderRead): Promise<unknown>
  /** 打开某条 key 的**订单专属页**（只开页面、不做任何点击），把后续操作交给 agent。 */
  keyOpen(keyId: number): Promise<KeyOpenResult>
  keyRedeem(keyId: number): Promise<ActionOutcome>
}

/** `keyOpen` 的结果：agent 接下来就在这个页面上干活。 */
export type KeyOpenResult =
  | { ok: true; keyId: number; name: string | null; pageId: number; url: string; title: string }
  | { ok: false; message: string }

/** 一个工具的定义：注入 Pi agent 所需的最小信息。 */
export interface ToolSpec {
  name: string
  title: string
  description: string
  /** 只读 / 写入 / 不可逆（用于权限分层与审计）。 */
  layer: 'L0' | 'L1' | 'L2'
  /** Pi SDK 要求参数是 TypeBox schema（顶层必须是 object）。 */
  parameters: TObject
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
export function createTools(host: McpHost): ToolSpec[] {
  return [...createDomainTools(host), ...createBrowserTools(host)].map((spec) => ({
    ...spec,
    description: spec.description.includes(MONOSPACE_TAG)
      ? spec.description
      : `${MONOSPACE_TAG} ${spec.description}`,
  }))
}

/** 领域工具（MonoSpace 自己的台账 / 同步 / 揭示 / 兑换）。 */
function createDomainTools(host: McpHost): ToolSpec[] {
  return [
    {
      name: `${TOOL_PREFIX}ledger_stats`,
      title: 'MonoSpace 台账统计',
      description:
        '统计 MonoSpace 台账：总数与「未揭示 / 已揭示未兑换 / 已兑换」分布、各引擎数量。只读。',
      layer: 'L0',
      parameters: Type.Object({}),
      run: () => host.ledgerStats(),
    },
    {
      name: `${TOOL_PREFIX}ledger_query`,
      title: 'MonoSpace 台账查询',
      description:
        '分页查询 MonoSpace 台账列表（资产名 / 包 / 订单 / 引擎 / 揭示与兑换状态）。**不含兑换码明文**；要码请用 key_context。只读。',
      layer: 'L0',
      parameters: Type.Object({
        view: Type.Optional(
          Type.Union([
            Type.Literal('all'),
            Type.Literal('unrevealed'),
            Type.Literal('revealed_unredeemed'),
            Type.Literal('redeemed'),
          ]),
        ),
        engine: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
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
      parameters: Type.Object({
        keyId: Type.Integer({ minimum: 1 }),
        includeCode: Type.Optional(Type.Boolean()),
      }),
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
      name: `${TOOL_PREFIX}keys_ingest`,
      title: 'MonoSpace 页面读取结果落库',
      description:
        '把你在订单页上**读到**的资产与密钥写进 MonoSpace 台账。\n' +
        'ADR-0003 定了：**key 与资产包只从页面读取**（接口只提供订单列表）。所以这是把页面读到的\n' +
        '东西落库的**唯一入口**。用法：page_open 打开某单订单页 → monospace_dom 看清页面 →\n' +
        '逐条读出资产名与「已揭示/未揭示」（已揭示的连密钥一起读）→ 用本工具写回。\n' +
        '纪律：**只写你真的在页面上看到的**。未揭示的不要给 code；已揭示但没读到码就别编，' +
        '留空并重新读。写入类，强制留痕。',
      layer: 'L1',
      parameters: Type.Object({
        orderGamekey: Type.String({
          description: '订单 gamekey（从页面 URL /downloads?key=<gamekey> 取）',
        }),
        productName: Type.Optional(Type.String({ description: '页面上看到的订单/包名' })),
        bundleName: Type.Optional(
          Type.String({ description: '页面上看到的资产包分组名；看不出分组就省略' }),
        ),
        keys: Type.Array(
          Type.Object({
            name: Type.String({ description: '资产显示名（页面上那一行的名字）' }),
            revealed: Type.Boolean({ description: '页面是否已揭示（能看到码为 true）' }),
            code: Type.Optional(Type.String({ description: '已揭示时从页面读到的密钥明文' })),
            // **必填**：平台由应用从这个链接解析（输出 schema 内置在应用侧），
            // 所以 agent 只交原始证据，不许自己编平台名、也不许省略。
            redemptionUrl: Type.String({
              description:
                '这一行「Redemption Instructions」链接的 href（**必填**）。' +
                '平台由应用解析，你不需要（也不要）自己判断平台名。逐行给，因为同一页可能混多个平台。',
            }),
          }),
          {
            description:
              '这一单在页面上看到的所有 key。**平台逐条判断**：同一订单页可能混着多个平台，' +
              '所以每条 key 要各自带它那一行的 redemptionUrl（或已知的 platform）。',
          },
        ),
      }),
      run: (input) =>
        host.keysIngest({
          orderGamekey: input.orderGamekey as string,
          productName: input.productName as string | undefined,
          bundleName: input.bundleName as string | undefined,
          keys: input.keys as PageOrderRead['keys'],
        }),
    },
    {
      name: `${TOOL_PREFIX}orders_sync`,
      title: 'MonoSpace 同步订单（接口）',
      description:
        '让 MonoSpace 通过 **Humble 接口**跑一次只读同步：拉取订单列表与详情，增量写入台账（订单 → 引擎资产包 → key）。写入类，会留痕。',
      layer: 'L1',
      parameters: Type.Object({}),
      run: () => host.ordersSync(),
    },
    {
      name: `${TOOL_PREFIX}keys_upsert`,
      title: 'MonoSpace 回写 key 读取结果',
      description:
        '把外部 agent 从页面上读到的 key 信息（揭示状态 / 兑换码）写回 MonoSpace 台账。写入类，**强制留痕**。',
      layer: 'L1',
      parameters: Type.Object({
        entries: Type.Array(
          Type.Object({
            keyId: Type.Integer({ minimum: 1 }),
            code: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            revealed: Type.Optional(Type.Boolean()),
            note: Type.Optional(Type.String()),
          }),
          { minItems: 1, maxItems: 500 },
        ),
      }),
      run: (input) => host.keysUpsert(input.entries as KeyUpsertEntry[]),
    },
    {
      name: `${TOOL_PREFIX}key_open`,
      title: 'MonoSpace 打开某条 key 的订单页',
      description:
        '打开某条 key 所属订单的专属页（`/downloads?key=<gamekey>`，只列这一单、无分页），' +
        '并把它设为当前页面。**只开页面，不做任何点击**——揭示/兑换由你自己在这个页面上操作。' +
        '用法：先 key_open，再 monospace_dom 看页面，然后用 monospace_act 点页面自己的控件，' +
        '读到密钥后用 keys_upsert 写回台账。',
      layer: 'L1',
      parameters: Type.Object({
        keyId: Type.Integer({ minimum: 1, description: '台账里的 key id（先 ledger_query 拿）' }),
      }),
      run: (input) => host.keyOpen(input.keyId as number),
    },
    {
      name: `${TOOL_PREFIX}key_redeem`,
      title: 'MonoSpace 兑换某个 key（不可逆）',
      description:
        '让 MonoSpace 执行一次**兑换**（Epic 兑换页 + My Library 校验）。会打开可见窗口；如需登录/验证码/条款确认，会停在**人在环路**并把 pause 原因回给你。',
      layer: 'L2',
      parameters: Type.Object({ keyId: Type.Integer({ minimum: 1 }) }),
      run: (input) => host.keyRedeem(input.keyId as number),
    },
  ]
}
