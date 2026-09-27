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

/** 订单列表项（订单主视图）：带 key 计数。 */
export type OrderSummary = Awaited<ReturnType<LedgerApi['orders']>>[number]

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

/**
 * 平台：这条 key 在哪里兑换。**逐条判断**（ADR-0003）——同一订单页可能混着多个平台。
 */
export type Platform = LedgerListItem['platform']

/** 导出格式。 */
export type LedgerExportFormat = Parameters<LedgerApi['export']>[0]

/**
 * 调试日志快照（记录最新在前 + 是否正在运行）：形状从 preload 声明派生，避免两处维护。
 * 运行状态由主进程缓冲给出，面板据此自己决定要不要低频轮询（它已不接外部 props）。
 */
export type AgentLogSnapshot = Awaited<ReturnType<Window['api']['agent']['log']>>

/** 内置 agent 调试日志的一条记录。 */
export type AgentLogEntry = AgentLogSnapshot['entries'][number]

/** 日志类别（开始 / 结束 / 文本 / 工具）。 */
export type AgentLogKind = AgentLogEntry['kind']
