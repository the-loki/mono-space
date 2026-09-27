/**
 * 状态 → 中文标签。揭示状态 / 兑换状态两列各自独立显示（规格 #14 §5）。
 */
import type { NoCodeReason, Platform, RedeemStatus, RevealStatus } from './types'

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
 * 平台标签。平台由 agent 读页面时**逐行判断**后落库（ADR-0006），应用侧不再从兑换链接解析。
 */
export const PLATFORM_LABELS: Record<Platform, string> = {
  fab: 'Fab',
  epic: 'Epic',
  steam: 'Steam',
  unity: 'Unity',
  gog: 'GOG',
  unknown: '未知',
}

/**
 * 无码缘由标签（由 agent 判断后落库，界面只做展示）。
 *
 * 取值依据（本仓库真实数据实证）：页面写「此密钥已过期,不能再兑换」→ expired；
 * 点揭示后回「本产品密钥暂时耗尽 / 该产品密钥暂时已用尽」→ exhausted；
 * 只能去第三方商店凭链接领取、页面没有密钥栏 / 揭示控件 → link_only；判不出来 → unknown。
 */
export const NO_CODE_REASON_LABELS: Record<NoCodeReason, string> = {
  expired: '已过期',
  exhausted: '发行方缺货',
  link_only: '仅外部链接',
  unknown: '原因不明',
}

/** 揭示状态标签，未知值原样回退，保证 UI 不崩。 */
export function revealStatusLabel(status: RevealStatus): string {
  return REVEAL_STATUS_LABELS[status] ?? status
}

/** 兑换状态标签，未知值原样回退。 */
export function redeemStatusLabel(status: RedeemStatus): string {
  return REDEEM_STATUS_LABELS[status] ?? status
}
