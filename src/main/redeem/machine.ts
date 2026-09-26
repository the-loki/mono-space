/**
 * 兑换状态机（规格 #12 §6.1 的 11 态）。
 *
 * 纯函数 reducer：给定当前状态 + 事件，得出下一个状态与「是否中止整批」。
 * 终态幂等——到达终态后任何事件都不再改变状态（记账只写一次）。
 */
import type { RedeemStatus } from '../data/types'
import type { RedeemClassification } from './status'
import { isTerminal } from './status'

export interface RedeemState {
  status: RedeemStatus
  /** 已提交次数（每次真正点 Redeem 记一次）。 */
  attempts: number
  note: string
}

export type RedeemEvent =
  | { type: 'start' }
  | { type: 'precheckOk' }
  | { type: 'precheckBlocked'; detail: string }
  | { type: 'submit' }
  | { type: 'classified'; classification: RedeemClassification }
  | { type: 'libraryConfirmed' }
  | { type: 'libraryMissing'; detail: string }
  | { type: 'humanResolved' }
  | { type: 'retry' }
  | { type: 'sessionLost'; detail: string }
  | { type: 'unknownPage'; detail: string }
  | { type: 'captcha' }

export interface ReduceResult {
  state: RedeemState
  /** 本事件是否要求中止整批。 */
  abortBatch: boolean
}

export const INITIAL_STATE: RedeemState = { status: 'not_redeemed', attempts: 0, note: '未兑换' }

export function reduce(state: RedeemState, event: RedeemEvent): ReduceResult {
  const stay = (note?: string): ReduceResult => ({
    state: note ? { ...state, note } : state,
    abortBatch: false,
  })
  const go = (status: RedeemStatus, note: string, attempts = state.attempts): ReduceResult => ({
    state: { status, attempts, note },
    abortBatch: false,
  })

  // 终态幂等：不再接受任何事件——**但「页面说成功、库里没有」例外**，
  // 它是把 redeemed 降级为 needs_human 的唯一路径，必须放在守门之前。
  if (event.type === 'libraryMissing') {
    return state.status === 'redeemed' || state.status === 'redeeming'
      ? go('needs_human', `页面报成功但库中未确认：${event.detail}`)
      : stay()
  }
  if (isTerminal(state.status)) return stay()

  switch (event.type) {
    case 'start':
      if (state.status === 'not_redeemed' || state.status === 'needs_human') {
        return go('precheck', '只读前置校验中')
      }
      return stay()

    case 'precheckOk':
      return state.status === 'precheck' ? go('probing', '待提交') : stay()

    case 'precheckBlocked':
      return state.status === 'precheck' ? go('needs_human', event.detail) : stay()

    case 'submit':
      return state.status === 'probing'
        ? go('redeeming', '已提交，等待结果', state.attempts + 1)
        : stay()

    case 'classified':
      return state.status === 'redeeming'
        ? {
            state: {
              status: event.classification.status,
              attempts: state.attempts,
              note: event.classification.reason,
            },
            abortBatch: event.classification.abortBatch,
          }
        : stay()

    case 'libraryConfirmed':
      // 仅在 redeemed 上有意义（此时已是终态，幂等返回）。
      return stay('库里已确认')

    case 'retry':
      // 自动重试（仅用于可重试的归类，如节流）：回到待提交并保留已用次数。
      return state.status === 'needs_human' ? go('probing', '退避后重试') : stay()

    case 'humanResolved':
      return state.status === 'needs_human' ? go('probing', '人工处理后待重试') : stay()

    case 'sessionLost':
      return { ...go('needs_human', `登录态失效：${event.detail}`), abortBatch: true }

    case 'unknownPage':
      return go('needs_human', `页面不可识别：${event.detail}`)

    case 'captcha':
      return go('needs_human', '出现验证码/人机校验')

    default:
      return stay()
  }
}
