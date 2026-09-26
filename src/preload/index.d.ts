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

export interface MonoSpaceApi {
  ping(message: string): Promise<string>
  /** 台账：窄接口，只返回列表字段（无兑换码明文）。 */
  ledger: {
    list(query?: MonoSpaceLedgerKeyQuery): Promise<MonoSpaceLedgerKeyPage>
    count(query?: MonoSpaceLedgerKeyQuery): Promise<number>
    export(format: 'json' | 'csv', query?: MonoSpaceLedgerKeyQuery): Promise<string>
  }
}

declare global {
  interface Window {
    api: MonoSpaceApi
  }
}
