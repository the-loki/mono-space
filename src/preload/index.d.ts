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
  engine: 'unity' | 'unreal' | 'gamemaker' | 'unknown'
  /** 平台（逐条判断，界面只显示它，不显示引擎）。 */
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
  mappedOrderCount: number
  skippedOrderCount: number
  keyCount: number
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

export interface MonoSpaceApi {
  ping(message: string): Promise<string>
  /** 台账：窄接口，只返回列表字段（无兑换码明文）。 */
  ledger: {
    list(query?: MonoSpaceLedgerKeyQuery): Promise<MonoSpaceLedgerKeyPage>
    count(query?: MonoSpaceLedgerKeyQuery): Promise<number>
    export(format: 'json' | 'csv', query?: MonoSpaceLedgerKeyQuery): Promise<string>
  }
  /** 只读同步：拉 Humble 订单并增量入库。 */
  sync: {
    run(): Promise<MonoSpaceSyncResult>
  }
  /** 内置 agent：手动触发一次（工具注入自带 Pi，不依赖外部 agent）。 */
  agent: {
    status(): Promise<MonoSpaceAgentStatus>
    run(prompt: string): Promise<MonoSpaceAgentRunResult>
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
