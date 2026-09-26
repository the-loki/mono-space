/**
 * 台账单行：固定行高，供虚拟滚动窗口对齐。
 *
 * 只渲染 KeyListItem 的字段——**没有兑换码列**（规格 #14 §5：列表不预加载明文）。
 */
import type { JSX } from 'react'
import { ENGINE_LABELS, redeemStatusLabel, revealStatusLabel } from './labels'
import type { LedgerListItem } from './types'
import { LEDGER_ROW_HEIGHT } from './window'

/** 行内动作：揭示（未揭示时）或兑换（已揭示未兑换时）。 */
export type LedgerAction = 'reveal' | 'redeem'

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

/** 状态胶囊。 */
function StatusPill({ tone, children }: { tone: string; children: string }): JSX.Element {
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs leading-4 ${tone}`}>
      {children}
    </span>
  )
}

function revealTone(status: LedgerListItem['revealStatus']): string {
  return status === 'revealed'
    ? 'bg-emerald-900/60 text-emerald-200'
    : 'bg-amber-900/60 text-amber-200'
}

function redeemTone(status: LedgerListItem['redeemStatus']): string {
  switch (status) {
    case 'redeemed':
      return 'bg-emerald-900/60 text-emerald-200'
    case 'not_redeemed':
      return 'bg-slate-700/60 text-slate-200'
    case 'needs_human':
      return 'bg-orange-900/60 text-orange-200'
    default:
      return 'bg-sky-900/60 text-sky-200'
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
      className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_5rem_6rem_6rem_5rem] items-center gap-3 border-slate-800 border-b px-3 text-sm"
      style={{ height: LEDGER_ROW_HEIGHT }}
    >
      <span className="truncate" title={item.name ?? item.keyRemoteId}>
        {item.name ?? item.keyRemoteId}
      </span>
      <span className="truncate text-slate-400" title={item.bundleName ?? item.bundleRemoteId}>
        {item.bundleName ?? item.bundleRemoteId}
      </span>
      <span className="text-slate-400 text-xs">{ENGINE_LABELS[item.engine] ?? item.engine}</span>
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
            className="rounded bg-sky-800 px-2 py-1 text-sky-100 text-xs hover:bg-sky-700 disabled:opacity-50"
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
      className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_5rem_6rem_6rem_5rem] items-center gap-3 border-slate-800 border-b px-3"
      style={{ height: LEDGER_ROW_HEIGHT }}
    >
      <span className="h-3 w-40 animate-pulse rounded bg-slate-700" />
      <span className="h-3 w-28 animate-pulse rounded bg-slate-800" />
      <span className="h-3 w-12 animate-pulse rounded bg-slate-800" />
      <span className="h-3 w-14 animate-pulse rounded bg-slate-800" />
      <span className="h-3 w-14 animate-pulse rounded bg-slate-800" />
    </div>
  )
}
