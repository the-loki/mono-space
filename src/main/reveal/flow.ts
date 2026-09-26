/**
 * 单条揭示编排（`#25`；`docs/research/humble-reveal.md`）。
 *
 * 揭示是**不可逆写操作**（POST /humbler/redeemkey 会分配并占用 key），所以：
 * 1. **确定性预检**：只读判断会话/条目是否可揭示；
 * 2. **单条试探**：写之前先只读确认「确实还没揭示」（页面状态 + 接口核对，接口不提供码）；
 * 3. **恢复即重快照，不重放**：暂停后恢复时重新跑预检+试探，Humble 侧已有 key 就直接算成功，
 *    绝不把上次可能已落地的 POST 再打一次。
 *
 * 人在环路暂停点（登录 / reCAPTCHA / Guard 2FA / 陌生页 / 重试耗尽）只上报，不自动解决。
 */
import type { RevealOutcome } from './outcome'
import {
  INITIAL_REVEAL_STATE,
  type PauseReason,
  type RevealMachineState,
  reduceReveal,
} from './state'

export interface RevealInput {
  keyId: number
  /** Humble 订单 id（`order.gamekey`）。 */
  gamekey: string
  /** 资产包 machine_name（`tpk.machine_name`）。 */
  keytype: string
  keyindex: number
  /**
   * 资产显示名（台账 `key.name`）。
   *
   * **页面上认控件必须靠它**：页面渲染的是「Astronauts (Pack)」这种人看的名字，
   * 而 `keytype` 是机器名（`astronautspack_fab`）——实测行文本里**没有**机器名，
   * 只拿 keytype 去匹配会永远匹配不到（揭示路径会一直「交人工」）。
   */
  name?: string | null
}

export type PrecheckResult = { ok: true } | { ok: false; detail: string; pause: PauseReason }

export type ProbeResult =
  /** 确实还没揭示 → 才允许写。 */
  | { kind: 'needs-reveal' }
  /** 已有 key → 幂等，直接算已揭示（不写）。 */
  | { kind: 'already-revealed'; code: string }
  /** 该条目不可揭示（keyless / 无 keyindex / 未找到）→ 交人工。 */
  | { kind: 'unavailable'; detail: string; pause: PauseReason }

export interface RevealPorts {
  precheck(input: RevealInput): Promise<PrecheckResult>
  probe(input: RevealInput): Promise<ProbeResult>
  /** 真正的不可逆写操作；返回**已解析**的结果。 */
  submit(input: RevealInput): Promise<RevealOutcome>
  /**
   * 2xx 但没带 key 时的只读补偿：**重读页面**（不用接口——码只能来自页面）。
   * 读不到就返回 null，由 flow 判为交人工。
   */
  reRead(input: RevealInput): Promise<string | null>
  record(input: {
    keyId: number
    code: string | null
    status: 'revealed' | 'unrevealed'
    note: string
  }): Promise<void>
}

export interface RevealOptions {
  /** 最多写几次。默认 2（仅当结果可重试时才会真的重试）。 */
  maxAttempts?: number
}

export interface RevealResult {
  status: 'revealed' | 'needs_human'
  pause?: PauseReason
  code?: string
  attempts: number
  note: string
  recordError?: string
}

export async function revealOne(
  input: RevealInput,
  ports: RevealPorts,
  options: RevealOptions = {},
): Promise<RevealResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2)

  // 恢复也是从这里开始：每次调用都重新快照，绝不续跑。
  let machine: RevealMachineState = reduceReveal(INITIAL_REVEAL_STATE, { type: 'start' }).state

  const precheck = await ports.precheck(input)
  if (!precheck.ok) {
    machine = reduceReveal(machine, {
      type: 'pause',
      reason: precheck.pause,
      detail: precheck.detail,
    }).state
    return finish(machine, { keyId: input.keyId, code: null, ports })
  }
  machine = reduceReveal(machine, { type: 'precheckOk' }).state

  for (;;) {
    // 单条试探（只读）：写之前的最后一道闸，也是恢复时的幂等判据。
    const probe = await ports.probe(input)
    if (probe.kind === 'already-revealed') {
      machine = reduceReveal(machine, { type: 'probeAlreadyRevealed', code: probe.code }).state
      return finish(machine, { keyId: input.keyId, code: probe.code, ports })
    }
    if (probe.kind === 'unavailable') {
      machine = reduceReveal(machine, {
        type: 'pause',
        reason: probe.pause,
        detail: probe.detail,
      }).state
      return finish(machine, { keyId: input.keyId, code: null, ports })
    }
    machine = reduceReveal(machine, { type: 'probeNeedsReveal' }).state

    machine = reduceReveal(machine, { type: 'reveal' }).state
    const outcome = await ports.submit(input)

    if (outcome.kind === 'revealed') {
      machine = reduceReveal(machine, { type: 'revealed', code: outcome.code }).state
      return finish(machine, { keyId: input.keyId, code: outcome.code, ports })
    }

    if (outcome.kind === 'no-key-in-response') {
      // 只读补偿：不重放写操作。
      const code = await ports.reRead(input)
      if (code) {
        machine = reduceReveal(machine, { type: 'probeAlreadyRevealed', code }).state
        return finish(machine, { keyId: input.keyId, code, ports })
      }
      machine = reduceReveal(machine, {
        type: 'pause',
        reason: 'unknown-page',
        detail: outcome.message,
      }).state
      return finish(machine, { keyId: input.keyId, code: null, ports })
    }

    // 失败：只有明确可重试且还有次数时才重试，且重试前**重新快照**。
    const canRetry = outcome.retryable && machine.attempts < maxAttempts
    if (canRetry) {
      machine = reduceReveal(machine, { type: 'retry' }).state
      continue
    }

    machine = outcome.retryable
      ? reduceReveal(machine, { type: 'retryExhausted', detail: outcome.message }).state
      : reduceReveal(machine, {
          type: 'pause',
          reason: 'unavailable',
          detail: outcome.message,
        }).state
    return finish(machine, { keyId: input.keyId, code: null, ports })
  }
}

async function finish(
  machine: RevealMachineState,
  ctx: { keyId: number; code: string | null; ports: RevealPorts },
): Promise<RevealResult> {
  const revealed = machine.state === 'revealed'
  const result: RevealResult = {
    status: revealed ? 'revealed' : 'needs_human',
    attempts: machine.attempts,
    note: machine.note,
  }
  if (machine.pause) result.pause = machine.pause
  if (ctx.code) result.code = ctx.code

  // 只有真的变了才回写台账；暂停时不动台账（保持「未揭示」）。
  if (revealed || machine.pause === 'retries-exhausted') {
    try {
      await ctx.ports.record({
        keyId: ctx.keyId,
        code: ctx.code,
        status: revealed ? 'revealed' : 'unrevealed',
        note: machine.note,
      })
    } catch (error) {
      result.recordError = error instanceof Error ? error.message : String(error)
    }
  }
  return result
}
