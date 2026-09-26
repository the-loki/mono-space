/**
 * 渲染进程可见的窗口 API 类型。
 *
 * 这里自带台账声明（不 import 主进程类型）：tsconfig.web 只收录 `src/preload/*.d.ts`，
 * 跨项目 import 会触发 composite 的 TS6307。结构须与 `src/main/data/types.ts` 的
 * `KeyListItem` / `KeyQuery` / `KeyPage` 保持一致，渲染进程据此派生自己的类型。
 */

/** 台账列表项：不含兑换码明文。 */
export interface MonoSpaceLedgerKeyListItem {
  id: number
  accountId: string
  orderId: number
  orderRemoteId: string
  orderProductName: string | null
  orderPurchasedAt: string | null
  bundleId: number
  bundleRemoteId: string
  bundleName: string | null
  /** 平台（逐条判断，界面只显示它）。 */
  platform: 'fab' | 'epic' | 'steam' | 'unity' | 'gog' | 'unknown'
  publisher: string | null
  keyRemoteId: string
  name: string | null
  keyType: string | null
  revealStatus: 'unrevealed' | 'revealed'
  revealedAt: string | null
  redeemStatus:
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
  redeemedAt: string | null
}

/** 列表查询条件。 */
export interface MonoSpaceLedgerKeyQuery {
  view?: 'all' | 'unrevealed' | 'revealed_unredeemed' | 'redeemed'
  revealStatus?: MonoSpaceLedgerKeyListItem['revealStatus']
  redeemStatus?: MonoSpaceLedgerKeyListItem['redeemStatus']
  /** 按订单过滤（订单 gamekey）。不给＝全部订单。 */
  orderRemoteId?: string
  search?: string
  limit?: number
  offset?: number
}

/** 分页结果。 */
export interface MonoSpaceLedgerKeyPage {
  items: MonoSpaceLedgerKeyListItem[]
  total: number
  limit: number
  offset: number
}

/**
 * 订单列表项（订单主视图）：带 key 计数。
 * 商品名 / 购买时间在「页面读过之前」为 null；key 计数此时为 0。
 */
export interface MonoSpaceLedgerOrderSummary {
  accountId: string
  orderId: number
  orderRemoteId: string
  productName: string | null
  purchasedAt: string | null
  keyCount: number
  unrevealedCount: number
  revealedCount: number
  hasPageKeys: boolean
}

export interface MonoSpaceTaskResult {
  status: string
  pause?: string
  code?: string
  attempts: number
  note: string
}

/** 同步报告摘要（渲染进程只关心这几项）。 */
export interface MonoSpaceSyncSummary {
  orderCount: number
  snapshotId: number
}

export type MonoSpaceSyncResult =
  | { ok: true; report: MonoSpaceSyncSummary & Record<string, unknown> }
  | { ok: false; reason: 'not-logged-in' | 'error'; message: string }

/** 打开的登录窗口。 */
export interface MonoSpaceLoginWindow {
  store: string
  requestedUrl: string
  url: string
  status: number
  title: string
}

/** 内置 agent 的工具调用记录。 */
export interface MonoSpaceAgentToolCall {
  name: string
  ok: boolean
}

/** 内置 agent 的一次运行结果。 */
export interface MonoSpaceAgentRunResult {
  ok: boolean
  text: string
  toolCalls: MonoSpaceAgentToolCall[]
  message?: string
}

/** 内置 agent 的配置状态。 */
export interface MonoSpaceAgentStatus {
  ready: boolean
  reason?: string
}

/**
 * 内置 agent 调试日志的一条记录（仅内存、不落盘；本机排查用）。
 * 结构须与 `src/main/agent/log-buffer.ts` 的 `AgentLogEntry` 保持一致。
 */
export interface MonoSpaceAgentLogEntry {
  /** 单调递增序号：稳定顺序，最新在前时用它排序 / 去重。 */
  seq: number
  /** ISO 时间戳。 */
  at: string
  kind: 'run_start' | 'run_end' | 'turn_text' | 'tool'
  /** 工具名（仅 tool 条目）。 */
  tool?: string
  /** 摘要：工具参数 / prompt / 回合文本 / 最终状态（参数摘要已截断）。 */
  detail: string
  /** 工具结果摘要（tool 条目在结束时补上）。 */
  result?: string
  /** 是否失败。 */
  failed: boolean
}

export interface MonoSpaceApi {
  ping(message: string): Promise<string>
  /** 台账：窄接口，只返回列表字段（无兑换码明文）。 */
  ledger: {
    list(query?: MonoSpaceLedgerKeyQuery): Promise<MonoSpaceLedgerKeyPage>
    count(query?: MonoSpaceLedgerKeyQuery): Promise<number>
    /** 订单主视图：全部订单 + 各自的 key 计数。 */
    orders(): Promise<MonoSpaceLedgerOrderSummary[]>
    export(format: 'json' | 'csv', query?: MonoSpaceLedgerKeyQuery): Promise<string>
  }
  /** 只读同步：拉 Humble 订单并增量入库。 */
  sync: {
    run(): Promise<MonoSpaceSyncResult>
  }
  /**
   * 内置 agent。**没有自由输入**：提示词与输出 schema 都在主进程侧，
   * 渲染层只按内置任务传标识（gamekey / keyId）。
   */
  agent: {
    status(): Promise<MonoSpaceAgentStatus>
    /** 内置任务：按订单读全部 key 并落库。 */
    readOrderKeys(gamekey: string): Promise<MonoSpaceAgentRunResult>
    /** 内置任务：揭示单条 key（不可逆）。 */
    revealKey(keyId: number): Promise<MonoSpaceAgentRunResult>
    /** 调试日志快照（最新在前）：仅主进程内存，进程内有效。 */
    log(): Promise<MonoSpaceAgentLogEntry[]>
    /** 清空调试日志。 */
    clearLog(): Promise<void>
  }
  /** 单条动作：揭示 / 兑换（会打开可见窗口供人接管）。 */
  tasks: {
    login(): Promise<MonoSpaceLoginWindow[]>
    redeem(keyId: number): Promise<MonoSpaceTaskResult>
  }
}

declare global {
  interface Window {
    api: MonoSpaceApi
  }
}
