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
import { normalizeNoCodeReason } from '../data/no-code-reason'
import type { PageOrderRead } from '../data/page-ingest'
import type { RedeemStatus } from '../data/types'
import type { BrowserHost } from './host-contract'
import { createBrowserTools } from './tools-browser'

/** L0 只读：台账统计。 */
export interface LedgerStats {
  total: number
  unrevealed: number
  revealedUnredeemed: number
  redeemed: number
}

/** 台账列表项（**不含兑换码明文**，`#14` §5）。 */
export interface LedgerRow {
  keyId: number
  name: string | null
  bundle: string | null
  order: string | null
  revealStatus: string
  redeemStatus: string
}

/** 写入结果（含留痕）。 */
export interface UpsertResult {
  written: number
  /** 写入页面行的码时吸收掉（删除）的同单同码 `api:` 补充行条数（ADR-0004 修订）。 */
  absorbed: number
  auditId: string
}

/** 浏览器导航结果。 */
export interface BrowserNavResult {
  url: string
  title: string
  /** did-navigate 的 HTTP 状态（或 -1）。 */
  status: number
}

/** 兑换结果**登记**的结果（不代替提交，见 ADR-0005）。 */
export interface RedeemRecordResult {
  /** 是否真的写进了台账（找不到该 key 时为 false）。 */
  ok: boolean
  keyId: number
  status: RedeemStatus
  note: string
}

/**
 * agent 可登记的兑换结果状态：**逐字复用台账已有的兑换状态词汇**
 * （`data/types.ts` 的 `REDEEM_STATUSES`），不发明新值。
 * 只收「结果」——`precheck` / `probing` / `redeeming` 是应用内部的过渡态，不属于结果。
 */
export const REDEEM_RECORDABLE_STATUSES = [
  'not_redeemed',
  'redeemed',
  'already_owned',
  'invalid',
  'used',
  'expired',
  'region_blocked',
  'needs_human',
] as const

/** `keys_upsert` 的单条输入。 */
export interface KeyUpsertEntry {
  keyId: number
  /** 从页面读到的兑换码（可选；有则写）。 */
  code?: string | null
  /** 从页面读到的揭示状态。 */
  revealed?: boolean
  /** 拿不到码时的无码缘由（可选；有码不用给）。原始字符串，写入前由应用收敛。 */
  noCodeReason?: string | null
}

/**
 * 工具背后的宿主。全部由主进程实现（持有 store 会话与台账）。
 * 浏览器能力来自 `host-contract.ts` 的 `BrowserHost`（Chrome MCP 的忠实镜像）。
 */
export interface McpHost extends BrowserHost {
  ledgerStats(): Promise<LedgerStats>
  ledgerQuery(input: {
    view?: string
    /** 按订单过滤（订单 gamekey）。不给＝全部订单。 */
    orderRemoteId?: string
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
  /** **登记**一次兑换结果（写台账 + 留痕）；真正的提交由 agent 在页面上完成。 */
  keyRedeem(input: {
    keyId: number
    status: RedeemStatus
    note?: string
  }): Promise<RedeemRecordResult>
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

/**
 * 收敛 agent 交上来的无码缘由（有则收敛，无则**原样不动**）。
 *
 * 「无则原样不动」是有意的：不往转发对象里塞 `noCodeReason: null`，
 * 免得改变「没给这一字段」的语义（也让既有转发断言保持逐字相同）。
 */
function normalizeNoCodeReasonField<T extends { noCodeReason?: string | null }>(entry: T): T {
  if (entry.noCodeReason === undefined) {
    return entry
  }
  return { ...entry, noCodeReason: normalizeNoCodeReason(entry.noCodeReason) }
}

/** 收敛 `keys_upsert` 每条 entry 的无码缘由。 */
function normalizeKeyUpsertEntries(entries: KeyUpsertEntry[]): KeyUpsertEntry[] {
  return entries.map(normalizeNoCodeReasonField)
}

/** 收敛 `keys_ingest` 每条页面 key 的无码缘由（`buildPageOrder` 还会再收敛一次，幂等）。 */
function normalizePageReadKeys(keys: PageOrderRead['keys']): PageOrderRead['keys'] {
  return keys.map(normalizeNoCodeReasonField)
}

/** 领域工具（MonoSpace 自己的台账 / 同步 / 揭示 / 兑换）。 */
function createDomainTools(host: McpHost): ToolSpec[] {
  return [
    {
      name: `${TOOL_PREFIX}ledger_stats`,
      title: 'MonoSpace 台账统计',
      description: '统计 MonoSpace 台账：总数与「未揭示 / 已揭示未兑换 / 已兑换」分布。只读。',
      layer: 'L0',
      parameters: Type.Object({}),
      run: () => host.ledgerStats(),
    },
    {
      name: `${TOOL_PREFIX}ledger_query`,
      title: 'MonoSpace 台账查询',
      description:
        '分页查询 MonoSpace 台账列表（资产名 / 包 / 订单 / 平台 / 揭示与兑换状态）。**不含兑换码明文**；要码请用 key_context。可用 orderRemoteId 只看某一单。只读。',
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
        orderRemoteId: Type.Optional(
          Type.String({ description: '只看某一单（订单 gamekey）。不给则全部订单。' }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      run: (input) =>
        host.ledgerQuery({
          view: input.view as string | undefined,
          orderRemoteId: input.orderRemoteId as string | undefined,
          limit: input.limit as number | undefined,
          offset: input.offset as number | undefined,
        }),
    },
    {
      name: `${TOOL_PREFIX}key_context`,
      title: 'MonoSpace 单条 key 上下文',
      description:
        '查 MonoSpace 台账里某条 key 的上下文（名称/包/订单/平台/揭示与兑换状态）。**仅当 includeCode=true 时才返回兑换码明文**，且此调用会留痕。',
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
        'ADR-0003 定了：**key 与资产包只从页面读取**（同步接口只提供订单列表）。所以这是把页面读到的\n' +
        '东西落库的**唯一入口**。ADR-0004：落库之后，**应用自己**会再问一次接口、把页面漏掉的码补上\n' +
        '（页面永远优先，你不用管，也不要用接口取码）。用法：page_open 打开某单订单页 → monospace_dom 看清页面 →\n' +
        '逐条读出资产名、**这一行的平台**（逐行判断，见 platform 字段说明）与「已揭示/未揭示」' +
        '（已揭示的连密钥一起读）→ 用本工具写回。\n' +
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
            // **必填，但允许为空**：空串与「无」**同样表示「这一行没有兑换链接」**，
            // 不要做成校验失败 —— 实测 agent 有时就是交空串，而 schema 报错会让**整笔写入回滚**，
            // 于是「一行没写」被放大成「整单丢失」（订单名、资产包、key 全都不更新）。
            // 该防的是「拿页面上别处的链接充数」（编造），不是空串（空串是诚实地说没有）。
            redemptionUrl: Type.String({
              description:
                '这一行「Redemption Instructions」链接的 href（兑换去向的证据，供你自己判断去哪里兑换）。' +
                '页面上确实没有这一行的兑换链接时，写「无」或留空都行；' +
                '**不要**把页面上别处（页脚、通用帮助）的链接拿来充数。' +
                '逐行给，因为同一页可能混多个平台。',
            }),
            // **必填，但取值不做约束**：平台由你判断。「必填」是为了防漏传（漏了就等于根本没人判断），
            // 但**不能做成枚举联合** —— 那样「判不出」的写法会在 schema 层直接报错，
            // 一行不合格就拖垮整单（`redemptionUrl` 的 minLength 教训，见 ADR-0003 与 ADR-0006）。
            // 所以：schema 只要求你给一个值；取值由应用**收敛**（空串 / 非法值一律落 `unknown`）。
            platform: Type.String({
              description:
                '**由你（agent）在页面上逐行判断**：这一行 key 的平台。**必填**。' +
                '取值范围（台账既有的平台名）：fab / epic / steam / unity / gog / unknown。' +
                '判不出来就写 unknown（界面上显示「未知」）—— 这是**合法答案**，不算漏传；但**不要编**。' +
                '**逐行判断**：同一订单页可能混排多个平台（同一次订单里 Epic 与 Unity 并存是实测过的），' +
                '每一行看它自己的「Redemption Instructions」链接以及该行文案；**不要假设「一页一平台」**。',
            }),
            // **可选**：有码的行不用给。取值自由字符串、不做枚举约束，应用侧只收敛：
            // 认不出的值落 `unknown`，绝不回滚整笔写入（一行取值奇怪不该连累整单）。
            noCodeReason: Type.Optional(
              Type.String({
                description:
                  '这一行**没有兑换码**时的缘由（**有码就不用给**）。取值：' +
                  'expired（已过期）/ exhausted（发行方缺货）/ link_only（仅外部链接）/ unknown（原因不明）。' +
                  '依据：页面写「此密钥已过期,不能再兑换」→ expired；' +
                  '点揭示后页面回「本产品密钥暂时耗尽 / 该产品密钥暂时已用尽」→ exhausted；' +
                  '只能去第三方商店凭链接领取、页面没有密钥栏 / 揭示控件 → link_only；' +
                  '**判不出来写 unknown，不要编**。取值由应用收敛（非法值落 unknown，不会让整笔失败）。',
              }),
            ),
          }),
          {
            description:
              '这一单在页面上看到的所有 key。**平台逐条判断**：同一订单页可能混着多个平台，' +
              '所以每条 key 要各自带它那一行的 redemptionUrl，并各自给出它那一行的 platform。' +
              '**页面上没有 key 的订单**（音乐 / 电子书下载包之类）也要调用本工具：' +
              '给出 productName、keys 传空数组 —— 否则台账记不住这单是什么，界面只能显示「未读取」。',
          },
        ),
      }),
      run: (input) =>
        host.keysIngest({
          orderGamekey: input.orderGamekey as string,
          productName: input.productName as string | undefined,
          bundleName: input.bundleName as string | undefined,
          keys: normalizePageReadKeys(input.keys as PageOrderRead['keys']),
        }),
    },
    {
      name: `${TOOL_PREFIX}orders_sync`,
      title: 'MonoSpace 同步订单（接口）',
      description:
        '让 MonoSpace 通过 **Humble 接口**跑一次只读同步：只拉取**订单列表**（ADR-0003：接口不提供 key），增量写入台账的订单表。写入类，会留痕。',
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
            // **可选**：有码不用给；拿不到码时必须给。自由字符串、不做枚举约束，应用侧只收敛。
            noCodeReason: Type.Optional(
              Type.String({
                description:
                  '这一行**拿不到码**时的缘由（**有码就不用给**）。取值：' +
                  'expired（已过期）/ exhausted（发行方缺货）/ link_only（仅外部链接）/ unknown（原因不明）。' +
                  '**判不出来写 unknown，不要编**。取值由应用收敛，不会让你整笔失败。',
              }),
            ),
          }),
          { minItems: 1, maxItems: 500 },
        ),
      }),
      run: (input) => host.keysUpsert(normalizeKeyUpsertEntries(input.entries as KeyUpsertEntry[])),
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
      title: 'MonoSpace 登记某条 key 的兑换结果',
      description:
        '把**你已经在页面上完成**的那次兑换结果**登记**进 MonoSpace 台账（写状态 + 强制留痕）。\n' +
        '**这是登记，不会替你提交**：提交（填码 / 点提交）靠你在页面上用 monospace_act 自己完成。\n' +
        '用法：monospace_key_open(keyId) 打开那一单订单页 → 必要时先按页面自己的控件揭示拿到码 →\n' +
        '读那一行的「Redemption Instructions」链接决定去哪家商店 → 用页面自己的控件填码、提交 →\n' +
        '**从页面读出结果** → 再用本工具把结果写回台账。\n' +
        'status 只能取台账已有的兑换状态词： redeemed（已兑换）/ already_owned（已拥有）/ invalid（无效）/\n' +
        'used（已使用）/ expired（已过期）/ region_blocked（区域受限）/ needs_human（待人工）/ not_redeemed（未兑换）。\n' +
        '**不填中间态**（预检中 / 试探中 / 兑换中）：那是应用内部的过渡，不是结果。\n' +
        '提交不可逆：**只提交一次**；遇到验证码 / 需要确认条款 / 认不出页面或读不出结果时，\n' +
        '**停下来告诉用户**，不要用本工具猜一个状态。',
      layer: 'L1',
      parameters: Type.Object({
        keyId: Type.Integer({ minimum: 1, description: '台账里的 key id（先 ledger_query 拿）' }),
        status: Type.Union(
          [
            Type.Literal('not_redeemed'),
            Type.Literal('redeemed'),
            Type.Literal('already_owned'),
            Type.Literal('invalid'),
            Type.Literal('used'),
            Type.Literal('expired'),
            Type.Literal('region_blocked'),
            Type.Literal('needs_human'),
          ],
          { description: '你在页面上读到的兑换结果（只用台账已有的状态词）' },
        ),
        note: Type.Optional(
          Type.String({ description: '页面上看到的原文或简短说明（可选，便于事后核对）' }),
        ),
      }),
      run: (input) =>
        host.keyRedeem({
          keyId: input.keyId as number,
          status: input.status as RedeemStatus,
          note: input.note as string | undefined,
        }),
    },
  ]
}
