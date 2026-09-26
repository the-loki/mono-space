/**
 * 渲染进程侧的台账类型。
 *
 * 统一从 preload 声明（`src/preload/index.d.ts` 暴露的 `window.api`）派生，
 * 让跨进程契约只有一处定义：主进程改字段时，渲染进程会在 typecheck 阶段暴露。
 */

/** 台账 API 形状。 */
type LedgerApi = Window['api']['ledger']

/** 台账列表项（不含兑换码明文）。 */
export type LedgerListItem = Awaited<ReturnType<LedgerApi['list']>>['items'][number]

/** 分页结果。 */
export type LedgerPage = Awaited<ReturnType<LedgerApi['list']>>

/** 列表查询条件。 */
export type LedgerQuery = NonNullable<Parameters<LedgerApi['list']>[0]>

/** 台账筛选：三态 + 全部。 */
export type LedgerFilter = NonNullable<LedgerQuery['view']>

/** 揭示状态。 */
export type RevealStatus = LedgerListItem['revealStatus']

/** 兑换状态。 */
export type RedeemStatus = LedgerListItem['redeemStatus']

/** 引擎。 */
/**
 * 平台：这条 key 在哪里兑换。**逐条判断**（ADR-0003）——同一订单页可能混着多个平台。
 *
 * 界面上**只显示平台，不显示引擎**：引擎来自接口的 machine_name 后缀，而页面读取的 key
 * 没有 machine_name，页面驱动下引擎永远只能是「未知引擎」。
 */
export type Platform = LedgerListItem['platform']

/** 导出格式。 */
export type LedgerExportFormat = Parameters<LedgerApi['export']>[0]
