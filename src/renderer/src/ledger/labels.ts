/**
 * 状态 → 中文标签。揭示状态 / 兑换状态两列各自独立显示（规格 #14 §5）。
 */
import type { Platform, RedeemStatus, RevealStatus } from './types'

/** 揭示状态标签。 */
export const REVEAL_STATUS_LABELS: Record<RevealStatus, string> = {
  unrevealed: '未揭示',
  revealed: '已揭示',
}

/** 兑换状态标签（按规格 #12 的 11 态状态机）。 */
export const REDEEM_STATUS_LABELS: Record<RedeemStatus, string> = {
  not_redeemed: '未兑换',
  precheck: '预检中',
  probing: '试探中',
  redeeming: '兑换中',
  redeemed: '已兑换',
  already_owned: '已拥有',
  invalid: '无效',
  used: '已使用',
  expired: '已过期',
  region_blocked: '区域受限',
  needs_human: '待人工',
}

/**
 * 平台标签。
 *
 * **界面不显示引擎**（ADR-0003）：引擎来自接口的 machine_name，页面读取的 key 没有它，
 * 显示出来永远是「未知引擎」。平台能从页面链接逐条读出，才有意义。
 */
export const PLATFORM_LABELS: Record<Platform, string> = {
  fab: 'Fab',
  epic: 'Epic',
  steam: 'Steam',
  unity: 'Unity',
  gog: 'GOG',
  unknown: '未知',
}

/** 揭示状态标签，未知值原样回退，保证 UI 不崩。 */
export function revealStatusLabel(status: RevealStatus): string {
  return REVEAL_STATUS_LABELS[status] ?? status
}

/** 兑换状态标签，未知值原样回退。 */
export function redeemStatusLabel(status: RedeemStatus): string {
  return REDEEM_STATUS_LABELS[status] ?? status
}
