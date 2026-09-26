/**
 * 揭示状态机（`docs/spec/14` §3 步骤 6、`#25`）。
 *
 * 与兑换不同：揭示的暂停态**不落库**（台账只有 `unrevealed`/`revealed` 两态），
 * 所以这台状态机是**瞬态**的——暂停只活在内存/UI 里，恢复时靠「重快照」重新推导。
 *
 * 人在环路暂停点是一等公民：登录 / reCAPTCHA v2 / Humble Guard(2FA) / 陌生页 / 重试耗尽。
 */
export type RevealState =
  | 'idle'
  | 'precheck'
  | 'probing'
  | 'revealing'
  | 'revealed'
  | 'needs_human'
  | 'exhausted'

export type PauseReason =
  | 'login'
  | 'captcha'
  | 'guard'
  | 'unknown-page'
  | 'retries-exhausted'
  | 'unavailable'

export interface RevealMachineState {
  state: RevealState
  attempts: number
  /** 暂停原因（`needs_human` / `exhausted` 时有值）。 */
  pause?: PauseReason
  note: string
}

export type RevealEvent =
  | { type: 'start' }
  | { type: 'precheckOk' }
  | { type: 'pause'; reason: PauseReason; detail: string }
  | { type: 'probeNeedsReveal' }
  | { type: 'probeAlreadyRevealed'; code: string }
  | { type: 'reveal' }
  | { type: 'revealed'; code: string }
  | { type: 'retry' }
  | { type: 'retryExhausted'; detail: string }
  | { type: 'humanResolved' }

export const INITIAL_REVEAL_STATE: RevealMachineState = {
  state: 'idle',
  attempts: 0,
  note: '未开始',
}

/** 终态：到达后不再接受事件（`needs_human`/`exhausted` 不是终态，人工恢复后可重跑）。 */
const TERMINAL: readonly RevealState[] = ['revealed']

export interface RevealReduceResult {
  state: RevealMachineState
  /** 是否需要把控制权交还给人（UI 弹出暂停提示）。 */
  paused: boolean
}

export function reduceReveal(state: RevealMachineState, event: RevealEvent): RevealReduceResult {
  const stay = (note?: string): RevealReduceResult => ({
    state: note ? { ...state, note } : state,
    paused: false,
  })
  const go = (
    next: RevealState,
    note: string,
    extra: Partial<RevealMachineState> = {},
  ): RevealReduceResult => ({
    state: { state: next, attempts: state.attempts, note, ...extra },
    paused: next === 'needs_human' || next === 'exhausted',
  })

  if (TERMINAL.includes(state.state)) return stay()

  switch (event.type) {
    case 'start':
      return state.state === 'idle' || state.state === 'needs_human' || state.state === 'exhausted'
        ? go('precheck', '只读前置校验中')
        : stay()

    case 'precheckOk':
      return state.state === 'precheck' ? go('probing', '待单条试探') : stay()

    case 'pause':
      return state.state === 'precheck' || state.state === 'probing' || state.state === 'revealing'
        ? go('needs_human', event.detail, { pause: event.reason })
        : stay()

    case 'probeNeedsReveal':
      return state.state === 'probing' ? go('probing', '需要揭示（尚未写入）') : stay()

    case 'probeAlreadyRevealed':
      // 幂等：Humble 侧已揭示 → 不重放写操作，直接算已揭示（码来自页面，不来自接口）。
      return state.state === 'probing' || state.state === 'revealing'
        ? // 注意：note 可能被写进日志/UI，**不放 key 明文**（脱敏要求）。
          go('revealed', '订单里已有 key（幂等，不重写）')
        : stay()

    case 'reveal':
      return state.state === 'probing'
        ? {
            state: {
              state: 'revealing',
              attempts: state.attempts + 1,
              note: '已提交揭示（不可逆）',
            },
            paused: false,
          }
        : stay()

    case 'revealed':
      return state.state === 'revealing' ? go('revealed', '已揭示（码已回写台账）') : stay()

    case 'retry':
      // 自动重试：**回到 probing 重新快照**（写之前再只读确认一次），
      // 否则 attempts 不会累加、会无限重试。
      return state.state === 'revealing' ? go('probing', '退避后重新快照') : stay()

    case 'retryExhausted':
      return go('exhausted', event.detail, { pause: 'retries-exhausted' })

    case 'humanResolved':
      // 恢复一律回到 precheck（重快照），绝不从 revealing 续跑。
      return state.state === 'needs_human' || state.state === 'exhausted'
        ? go('precheck', '人工处理完成，重新快照')
        : stay()

    default:
      return stay()
  }
}
