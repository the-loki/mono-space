/**
 * 台账单行：固定行高，供虚拟滚动窗口对齐。
 *
 * 只渲染 KeyListItem 的字段——**没有兑换码列**（规格 #14 §5：列表不预加载明文）。
 * 行高必须与 `window.ts` 的 `LEDGER_ROW_HEIGHT` 一致：e2e 用它算占位高度，改这里必须同步。
 */
import type { JSX } from 'react'
import { PLATFORM_LABELS, redeemStatusLabel, revealStatusLabel } from './labels'
import type { LedgerListItem } from './types'
import { LEDGER_ROW_HEIGHT } from './window'

/** 行内动作：揭示（未揭示时）或兑换（已揭示未兑换时）。 */
export type LedgerAction = 'reveal' | 'redeem'

/** 明细视图的列网格：`OrderKeysPage` 的表头与这里共用，保证列对齐。 */
export const LEDGER_GRID =
  'grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_5rem_6rem_6.5rem_6rem] items-center gap-3'

interface LedgerRowProps {
  item: LedgerListItem
  /** 该行正在进行动作（禁用按钮）。 */
  busy?: boolean
  onAction?: (action: LedgerAction, item: LedgerListItem) => void
}

/** 该行当前能做什么（无则为 null）。 */
export function actionFor(item: LedgerListItem): LedgerAction | null {
  if (item.revealStatus !== 'revealed') return 'reveal'
  if (item.redeemStatus !== 'redeemed') return 'redeem'
  return null
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
      <span className="truncate text-ink" title={item.name ?? item.keyRemoteId}>
        {item.name ?? item.keyRemoteId}
      </span>
      <span
        className={`truncate text-ink-3 ${item.bundleName ? '' : 'font-mono text-xs'}`}
        title={item.bundleName ?? item.bundleRemoteId}
      >
        {item.bundleName ?? item.bundleRemoteId}
      </span>
      <span className="text-ink-3 text-xs">{PLATFORM_LABELS[item.platform] ?? item.platform}</span>
      <span data-testid="reveal-status">
        <StatusPill tone={revealTone(item.revealStatus)}>
          {revealStatusLabel(item.revealStatus)}
        </StatusPill>
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
      <span className="h-3 w-28 animate-pulse rounded bg-line" />
      <span className="h-3 w-12 animate-pulse rounded bg-line" />
      <span className="h-3 w-14 animate-pulse rounded bg-line" />
      <span className="h-3 w-14 animate-pulse rounded bg-line" />
      <span className="h-3 w-14 animate-pulse rounded bg-line" />
    </div>
  )
}
