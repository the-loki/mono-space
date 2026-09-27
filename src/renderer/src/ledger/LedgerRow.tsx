/**
 * 台账单行：固定行高，供虚拟滚动窗口对齐。
 *
 * 只渲染 KeyListItem 的字段——**没有兑换码列**（规格 #14 §5：列表不预加载明文）。
 * 行高必须与 `window.ts` 的 `LEDGER_ROW_HEIGHT` 一致：e2e 用它算占位高度，改这里必须同步。
 */
import type { JSX } from 'react'
import {
  NO_CODE_REASON_LABELS,
  PLATFORM_LABELS,
  redeemStatusLabel,
  revealStatusLabel,
} from './labels'
import type { LedgerListItem } from './types'
import { LEDGER_ROW_HEIGHT } from './window'

/** 行内动作：揭示（未揭示时）或兑换（已揭示未兑换时）。 */
export type LedgerAction = 'reveal' | 'redeem'

/** 明细视图的列网格：`OrderKeysPage` 的表头与这里共用，保证列对齐。
 *
 * 为什么没有「包」列：包身份就是 `<gamekey>_page`，而本视图已经限定在**一个订单**内，
 * 实测 68 单没有一单挂两个包（多包情况为空）——那列每一行都在重复同一个值，
 * 白占 1.6fr 宽度，把「资产」名挤到截断。要看包名去导出/详情标题。 */
export const LEDGER_GRID =
  'grid grid-cols-[minmax(0,3fr)_5rem_6rem_7rem_6.5rem_6rem] items-center gap-3'

interface LedgerRowProps {
  item: LedgerListItem
  /** 该行正在进行动作（禁用按钮）。 */
  busy?: boolean
  onAction?: (action: LedgerAction, item: LedgerListItem) => void
}

/**
 * 该行当前能做什么（无则为 null）。
 *
 * `already_owned`（已拥有）也算终态、不再给动作 —— `docs/spec/12` §6 明确「已拥有**视同成功**」：
 * 商品已在账号里，再提交一次只会把码白花掉。这一条是**真机跑出来的**：真跑 `id=197` 得到
 * `already_owned`，而当时界面还在给它显示「兑换」按钮（`docs/verify/37`）。
 */
export function actionFor(item: LedgerListItem): LedgerAction | null {
  if (item.revealStatus !== 'revealed') return 'reveal'
  if (item.redeemStatus === 'redeemed' || item.redeemStatus === 'already_owned') return null
  return 'redeem'
}

/** 状态胶囊。语义色只是辅助——含义始终由中文标签承载（不靠颜色单独传意）。 */
function StatusPill({ tone, children }: { tone: string; children: string }): JSX.Element {
  return <span className={`badge ${tone}`}>{children}</span>
}

/** 揭示状态：未揭示=待办（琥珀），已揭示=完成（翠绿）。 */
function revealTone(status: LedgerListItem['revealStatus']): string {
  return status === 'revealed' ? 'badge-done' : 'badge-pending'
}

/**
 * 兑换状态（11 态状态机）：
 * 可兑换=天蓝（有动作可做）· 进行中=紫 · 终态无解=灰 · 需人工/受限=橙 · 失效=红。
 */
function redeemTone(status: LedgerListItem['redeemStatus']): string {
  switch (status) {
    case 'redeemed':
    case 'already_owned':
      // `already_owned` 与已兑换同色：`docs/spec/12` §6 把它记为「**视同成功**」
      //（商品已在账号里，无需再做任何事）。
      return 'badge-done'
    case 'not_redeemed':
      return 'badge-todo'
    case 'precheck':
    case 'probing':
    case 'redeeming':
      return 'badge-progress'
    case 'needs_human':
    case 'region_blocked':
      return 'badge-warn'
    case 'invalid':
    case 'used':
    case 'expired':
      return 'badge-danger'
    default:
      return 'badge-muted'
  }
}

/**
 * 无码缘由配色：过期 / 发行方缺货＝橙色（这一行暂时无解，值得留意）；
 * 仅外部链接 / 原因不明＝灰色（中性）。颜色只是辅助，含义始终由中文文案承载。
 */
function noCodeReasonTone(reason: NonNullable<LedgerListItem['noCodeReason']>): string {
  switch (reason) {
    case 'expired':
    case 'exhausted':
      return 'badge-warn'
    default:
      return 'badge-muted'
  }
}

/** 一行台账记录。 */
export function LedgerRow({ item, busy = false, onAction }: LedgerRowProps): JSX.Element {
  const action = actionFor(item)
  return (
    <div
      data-testid="ledger-row"
      data-key-id={item.id}
      data-reveal-status={item.revealStatus}
      data-redeem-status={item.redeemStatus}
      className={`${LEDGER_GRID} border-line border-b px-3 text-sm transition-colors last:border-b-0
        hover:bg-surface-hover`}
      style={{ height: LEDGER_ROW_HEIGHT }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-ink" title={item.name ?? item.keyRemoteId}>
          {item.name ?? item.keyRemoteId}
        </span>
        {/* 同单同名带码提示：**只在**本行无码时才会有计数（SQL 侧的 CASE），所以不必再判一次。
            它只是提示，不合并任何数据（连接键只能是兑换码，ADR-0004/0005）——
            页面这行标「未揭示」不代表台账里没这个资产的码（docs/verify/34：46 条里 27 条如此）。 */}
        {item.sameNameCodeCount > 0 && (
          <span
            data-testid="key-same-name-code"
            data-count={item.sameNameCodeCount}
            title={`同一订单里另有 ${item.sameNameCodeCount} 行**同名且已有兑换码**。页面这一行没码不代表台账里没这个资产的码，不必为它重跑揭示（只提示，不合并）。`}
            className="badge badge-muted shrink-0"
          >
            同名行带码 ×{item.sameNameCodeCount}
          </span>
        )}
      </span>
      <span className="text-ink-3 text-xs">{PLATFORM_LABELS[item.platform] ?? item.platform}</span>
      <span data-testid="reveal-status">
        <StatusPill tone={revealTone(item.revealStatus)}>
          {revealStatusLabel(item.revealStatus)}
        </StatusPill>
      </span>
      {/* 无码缘由：只有**没有码**的行才有值（写码时会被清空，见 repository），
          所以这里不必另问「有没有码」；列头已说明是哪一栏，徽章只写缘由本身。 */}
      <span>
        {item.noCodeReason && (
          <span
            data-testid="key-no-code-reason"
            data-reason={item.noCodeReason}
            title={`无码缘由：${NO_CODE_REASON_LABELS[item.noCodeReason]}`}
            className={`badge ${noCodeReasonTone(item.noCodeReason)}`}
          >
            {NO_CODE_REASON_LABELS[item.noCodeReason]}
          </span>
        )}
      </span>
      <span data-testid="redeem-status">
        <StatusPill tone={redeemTone(item.redeemStatus)}>
          {redeemStatusLabel(item.redeemStatus)}
        </StatusPill>
      </span>
      <span>
        {action && (
          <button
            type="button"
            data-testid="ledger-action"
            data-action={action}
            disabled={busy}
            onClick={() => onAction?.(action, item)}
            className="btn btn-xs btn-accent-quiet"
          >
            {busy ? '进行中…' : action === 'reveal' ? '揭示' : '兑换'}
          </button>
        )}
      </span>
    </div>
  )
}

/** 该页尚未拉回时的骨架行，保持行高稳定，避免滚动跳动。 */
export function LedgerSkeletonRow({ index }: { index: number }): JSX.Element {
  return (
    <div
      data-testid="ledger-row-skeleton"
      data-row-index={index}
      className={`${LEDGER_GRID} border-line border-b px-3`}
      style={{ height: LEDGER_ROW_HEIGHT }}
    >
      <span className="h-3 w-40 animate-pulse rounded bg-line-strong" />
      <span className="h-3 w-12 animate-pulse rounded bg-line" />
      <span className="h-3 w-14 animate-pulse rounded bg-line" />
      <span className="h-3 w-14 animate-pulse rounded bg-line" />
      <span className="h-3 w-14 animate-pulse rounded bg-line" />
      <span className="h-3 w-14 animate-pulse rounded bg-line" />
    </div>
  )
}
