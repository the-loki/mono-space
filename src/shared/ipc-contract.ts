/**
 * 跨进程 IPC 契约的**唯一来源**（纯类型：本文件不 import 任何东西）。
 *
 * 为什么单独放这里：preload 的 `index.d.ts` 要让渲染层看见这些形状，而它**不能** import
 * 主进程模块——那些模块带 `node:*` / `electron` 类型，会把 Node 类型拖进 `tsconfig.web`。
 * 把「过 IPC 的数据形状」集中到本文件后，主进程与 preload 声明都从这里取，
 * 任何一处漏改都会变成编译错误，而不是静默看不见。
 */

// ————————————————————————————— 台账 —————————————————————————————

/** 揭示状态：Key 是否已在 Humble 侧分配出兑换码（不可逆写操作的本地记录）。 */
export type RevealStatus = 'unrevealed' | 'revealed'

/**
 * 兑换状态：按规格 #12 的 11 态状态机。错误码为主键，未列出归入 needs_human。
 * 与揭示状态相互独立——揭示与兑换分开走。
 */
export type RedeemStatus =
  | 'not_redeemed'
  | 'precheck'
  | 'probing'
  | 'redeeming'
  | 'redeemed'
  | 'already_owned'
  | 'invalid'
  | 'used'
  | 'expired'
  | 'region_blocked'
  | 'needs_human'

/**
 * 平台：这条 key 在哪里兑换。
 *
 * **逐条判断**（ADR-0003）：同一订单页可能混着多个平台的 key，所以它是 key 级属性，
 * 由 agent 读那一行自己的「Redemption Instructions」链接得出。认不出一律 `unknown`。
 */
export type Platform = 'fab' | 'epic' | 'steam' | 'unity' | 'gog' | 'unknown'

/**
 * 无码缘由：这条 key 在页面上**拿不到兑换码**时的原因。
 *
 * **只有 agent 能给**（与平台同一条边界，ADR-0006）：页面文案是语义判断，
 * 应用侧不写正则去猜（那类代码已被明确删除）。schema 里落的是自由字符串，
 * 应用侧只用 `normalizeNoCodeReason` 收敛取值，绝不因为一行取值奇怪就回滚整笔写入。
 *
 * 取值依据（本仓库真实数据实证）：页面写「此密钥已过期,不能再兑换」→ `expired`；
 * 点揭示后回「本产品密钥暂时耗尽 / 该产品密钥暂时已用尽」→ `exhausted`；
 * 只能去第三方商店凭链接领取、页面没有密钥栏 / 揭示控件 → `link_only`；
 * 判不出来 → `unknown`（**合法答案，不算漏传；但不许编**）。
 */
export type NoCodeReason = 'expired' | 'exhausted' | 'link_only' | 'unknown'

/** 台账视图：任务要求的三类筛选，外加 all。 */
export type LedgerView = 'all' | 'unrevealed' | 'revealed_unredeemed' | 'redeemed'

/** 台账列表项：不含兑换码明文（列表只显示状态，码按需读取）。 */
export interface KeyListItem {
  id: number
  accountId: string
  orderId: number
  orderRemoteId: string
  orderProductName: string | null
  bundleId: number
  bundleRemoteId: string
  bundleName: string | null
  publisher: string | null
  keyRemoteId: string
  name: string | null
  keyType: string | null
  /** 平台（逐条判断，见 `Platform`）。 */
  platform: Platform
  /**
   * 无码缘由（逐行、可空）：这条 key 没有兑换码时的原因。
   *
   * `null` ＝「有码」或「还没判定」——写码时该字段会被清空（见仓储 `upsertKey`），
   * 所以「非 null」就等价于「无码且已判定」，界面无需另问「有没有码」。
   */
  noCodeReason: NoCodeReason | null
  revealStatus: RevealStatus
  revealedAt: string | null
  redeemStatus: RedeemStatus
  redeemedAt: string | null
}

/** 列表查询条件。 */
export interface KeyQuery {
  view?: LedgerView
  revealStatus?: RevealStatus
  redeemStatus?: RedeemStatus
  /** 按订单过滤（订单 gamekey）。不给＝全部订单。 */
  orderRemoteId?: string
  /** 名称模糊匹配（key 名或订单名）。 */
  search?: string
  limit?: number
  offset?: number
}

/** 分页结果。 */
export interface KeyPage {
  items: KeyListItem[]
  total: number
  limit: number
  offset: number
}

/**
 * 订单列表项（带 key 计数）：界面主视图用。
 *
 * 同步只提供 gamekey，商品名要等页面读过才有，所以它可能为 null；
 * 同理订单在读过页面前 keyCount 为 0，也必须出现在列表里（查询用 LEFT JOIN）。
 */
export interface OrderSummary {
  accountId: string
  orderId: number
  orderRemoteId: string
  productName: string | null
  /** 该订单下的 key 总数。 */
  keyCount: number
  unrevealedCount: number
  revealedCount: number
  /** 是否已从页面读过 key（= 有任何 key）。 */
  hasPageKeys: boolean
}

/** 导出格式，与仓储的导出方法一一对应。 */
export type LedgerExportFormat = 'json' | 'csv'

// ————————————————————————————— 同步 —————————————————————————————

/** 同步报告里渲染层关心的字段（主进程的完整报告是它的超集）。 */
export interface SyncSummary {
  orderCount: number
  snapshotId: number
}

/** 同步失败：不抛给渲染进程，而是给结构化的可读原因。 */
export type SyncFailure = {
  ok: false
  reason: 'not-logged-in' | 'error'
  message: string
}

/**
 * 同步结果。`Report` 的粒度由调用侧决定：主进程用完整的 `SyncReport`，渲染层用
 * `SyncSummary`。`Report extends SyncSummary` 让「报告里渲染层关心的字段」改名 / 删除
 * 立刻编译不过，而不是让渲染层悄悄读到一个不存在的字段。
 */
export type SyncIpcResult<Report extends SyncSummary = SyncSummary> =
  | { ok: true; report: Report }
  | SyncFailure

// ————————————————————————————— 内置 agent —————————————————————————————

/** 内置 agent 的一次工具调用记录。 */
export interface AgentToolCall {
  name: string
  /** 工具抛错时记 false（适配器约定：失败抛错，不把错误塞进内容）。 */
  ok: boolean
}

/** 内置 agent 的一次运行结果。 */
export interface AgentRunResult {
  ok: boolean
  /** 模型最终文本（无工具调用时就是回答本身）。 */
  text: string
  toolCalls: AgentToolCall[]
  /** 失败原因（配置缺失、模型报错等）。 */
  message?: string
}

/** 内置 agent 的配置状态。 */
export interface AgentStatus {
  /** 配置是否可用；不可用时 UI 该提示去配置而不是让按钮假装能用。 */
  ready: boolean
  reason?: string
}

/** 调试日志记录的类别。 */
export type AgentLogKind = 'run_start' | 'run_end' | 'turn_text' | 'tool'

/** 内置 agent 调试日志的一条记录（仅内存、不落盘；本机排查用）。 */
export interface AgentLogEntry {
  /** 单调递增序号：稳定顺序，最新在前时用它排序 / 去重。 */
  seq: number
  /** ISO 时间戳。 */
  at: string
  kind: AgentLogKind
  /** 工具名（仅 tool 条目）。 */
  tool?: string
  /** 摘要：工具参数 / prompt / 回合文本 / 最终状态（参数摘要已截断）。 */
  detail: string
  /** 工具结果摘要（tool 条目在结束时补上）。 */
  result?: string
  /** 是否失败。 */
  failed: boolean
}

/**
 * 调试日志快照：记录 + 当前是否正在运行。
 *
 * 为什么要带 `running`：面板在**独立调试窗口**里没有外部传入的运行状态，只能自己判断该不该
 * 低频轮询；运行状态本来就由主进程缓冲持有（`runStart` / `runEnd`），从 IPC 一起给出去才不会
 * 让渲染层去猜。
 */
export interface AgentLogSnapshot {
  /** 最新在前的记录（形状与既有语义一致，仍是数组）。 */
  entries: AgentLogEntry[]
  /** 是否有一次运行正在进行。 */
  running: boolean
}

// ————————————————————————————— 动作 —————————————————————————————

/** 打开过的登录窗口（id + 落地 URL + HTTP 状态）。 */
export interface LoginWindowResult {
  store: string
  requestedUrl: string
  url: string
  status: number
  title: string
}

// ————————————————————————————— 窗口 API —————————————————————————————

/**
 * 渲染层看到的 `window.api` 形状。
 *
 * preload 实现（`src/preload/index.ts`）用本接口标注 `api` 对象，`.d.ts` 又把同一接口
 * 挂到 `Window` 上；两者同源，方法面漂移会在实现侧直接编译不过。
 */
/**
 * 导出落盘结果：**用户取消不是错误**（`saved: false`，什么都没写）。
 *
 * 为什么不是「返回文本」：导出的文本原先只交给渲染层用了长度（`docs/verify/33-full-test.md` §0
 * 问题 1：499077 字符的 JSON 算完就被丢掉），用户拿不到任何文件。现在由主进程弹保存对话框写盘。
 */
export type LedgerExportSaveResult = { saved: true; path: string } | { saved: false }

export interface MonoSpaceApi {
  ping(message: string): Promise<string>
  /**
   * 窗口控制：无边框窗口（`frame: false`）自建标题栏用。
   *
   * 全部操作**发出请求的那个窗口**（主进程用 `BrowserWindow.fromWebContents(event.sender)`），
   * 因为调试窗口与主窗口共用同一套 preload/通道，写死主窗口会让调试窗口的关闭按钮关错窗口。
   */
  window: {
    /** 最小化当前窗口。 */
    minimize(): Promise<void>
    /** 最大化 / 还原当前窗口，返回操作后的最大化状态。 */
    toggleMaximize(): Promise<boolean>
    /** 关闭当前窗口。 */
    close(): Promise<void>
    /** 当前是否最大化（首帧同步按钮图标用）。 */
    isMaximized(): Promise<boolean>
    /**
     * 订阅最大化状态变化（WM 直接最大化 / 双击 / 快捷键也能同步图标）。
     * 返回取消订阅函数。
     */
    onMaximizedChange(listener: (maximized: boolean) => void): () => void
  }
  /** 台账：窄接口，只返回列表字段（无兑换码明文）。 */
  ledger: {
    list(query?: KeyQuery): Promise<KeyPage>
    count(query?: KeyQuery): Promise<number>
    /** 订单主视图：全部订单 + 各自的 key 计数。 */
    orders(): Promise<OrderSummary[]>
    export(format: LedgerExportFormat, query?: KeyQuery): Promise<LedgerExportSaveResult>
  }
  /** 只读同步：拉 Humble 订单并增量入库。 */
  sync: {
    run(): Promise<SyncIpcResult>
  }
  /**
   * 内置 agent。**没有自由输入**：提示词与输出 schema 都在主进程侧，
   * 渲染层只按内置任务传标识（gamekey / keyId）。
   */
  agent: {
    status(): Promise<AgentStatus>
    /** 内置任务：按订单读全部 key 并落库。 */
    readOrderKeys(gamekey: string): Promise<AgentRunResult>
    /** 内置任务：揭示单条 key（不可逆）。 */
    revealKey(keyId: number): Promise<AgentRunResult>
    /** 内置任务：兑换单条 key（提交由 agent 在页面上完成，工具只登记结果）。 */
    redeemKey(keyId: number): Promise<AgentRunResult>
    /** 调试日志快照（记录最新在前 + 运行状态）：仅主进程内存，进程内有效。 */
    log(): Promise<AgentLogSnapshot>
    /** 清空调试日志。 */
    clearLog(): Promise<void>
  }
  /** 调试面板独立窗口（用户决策：面板独立于台账页）。 */
  debug: {
    /** 打开（或聚焦已有的）调试窗口；幂等。 */
    open(): Promise<void>
  }
  /** 动作：登录（会打开可见窗口供人接管）。 */
  tasks: {
    login(): Promise<LoginWindowResult[]>
  }
}
