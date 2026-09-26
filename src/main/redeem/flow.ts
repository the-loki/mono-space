/**
 * 单条兑换编排（规格 #12 §6.1/§6.3、`docs/spec/14` §5）。
 *
 * 端口注入（precheck / submit / verifyInLibrary / record），因此：
 * - 编排逻辑可完全离线单测；
 * - v1 的端口由「可见窗口 + 扩展」实现，v1.1 的 agent 只替换 submit 的实现。
 *
 * 人在环路是**正常节点**：遇到 needs_human 就停下上报，不自动重试、不自动解决。
 */
import type { RedeemStatus } from '../data/types'
import { INITIAL_STATE, type RedeemEvent, type RedeemState, reduce } from './machine'
import { classifyError, type RedeemClassification } from './status'

/** 提交后页面落到哪种形态。`success` 与 `error` 互斥：成功页没有错误码。 */
export type SubmitPage = 'success' | 'error' | 'human' | 'unknown' | 'captcha' | 'logged-out'

export interface SubmitOutcome {
  page: SubmitPage
  /** 页面上的错误码（若有）。 */
  code?: string | null
  /** 页面上的文案（兜底用）。 */
  message?: string | null
}

export interface RedeemPorts {
  /** 只读前置校验：登录态是否有效、页面是否就位。 */
  precheck(code: string): Promise<{ ok: true } | { ok: false; detail: string }>
  /** 真正提交一次兑换码。 */
  submit(code: string): Promise<SubmitOutcome>
  /** 到 fab.com/library 确认该资产真的在库里。 */
  verifyInLibrary(name: string | null): Promise<boolean>
  /** 落盘记账（写 reveal/redeem 状态）。 */
  record(input: { keyId: number; status: RedeemStatus; note: string }): Promise<void>
}

export interface RedeemInput {
  keyId: number
  code: string
  name?: string | null
}

export interface RedeemOptions {
  /** 最多提交几次（含首次）。默认 2：仅当归类可重试时才会真的重试。 */
  maxAttempts?: number
}

export interface RedeemOutcome {
  status: RedeemStatus
  abortBatch: boolean
  retryable: boolean
  attempts: number
  note: string
  /** 记账失败时不为空（兑换结果本身仍以上面字段为准）。 */
  recordError?: string
}

/** 把一次提交结果翻译成状态机事件。 */
export function toEvent(outcome: SubmitOutcome): RedeemEvent {
  switch (outcome.page) {
    case 'logged-out':
      return { type: 'sessionLost', detail: '页面跳转到登录' }
    case 'captcha':
      return { type: 'captcha' }
    case 'unknown':
      return { type: 'unknownPage', detail: outcome.message ?? '未知页面' }
    case 'human':
      return {
        type: 'classified',
        classification: {
          status: 'needs_human',
          abortBatch: false,
          retryable: false,
          reason: outcome.message ?? '页面要求人工介入',
        },
      }
    case 'success':
      return {
        type: 'classified',
        classification: {
          status: 'redeemed',
          abortBatch: false,
          retryable: false,
          reason: outcome.message ?? '页面显示成功',
        },
      }
    default:
      return { type: 'classified', classification: classifyError(outcome) }
  }
}

function classificationOf(outcome: SubmitOutcome): RedeemClassification {
  const event = toEvent(outcome)
  if (event.type === 'classified') return event.classification
  return { status: 'needs_human', abortBatch: false, retryable: false, reason: '非结果页' }
}

/**
 * 兑换一条 key。返回最终状态；无论成功失败都会尝试记账（记账失败不掩盖兑换结果）。
 */
export async function redeemOne(
  input: RedeemInput,
  ports: RedeemPorts,
  options: RedeemOptions = {},
): Promise<RedeemOutcome> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2)
  let state: RedeemState = reduce(INITIAL_STATE, { type: 'start' }).state
  let abortBatch = false
  let retryable = false

  const precheck = await ports.precheck(input.code)
  const afterPrecheck = precheck.ok
    ? reduce(state, { type: 'precheckOk' })
    : reduce(state, { type: 'precheckBlocked', detail: precheck.detail })
  state = afterPrecheck.state

  if (state.status !== 'probing') {
    return finish(state, { abortBatch: false, retryable: false, keyId: input.keyId, ports })
  }

  for (;;) {
    state = reduce(state, { type: 'submit' }).state
    const outcome = await ports.submit(input.code)
    const classification = classificationOf(outcome)
    retryable = classification.retryable

    const applied = reduce(state, toEvent(outcome))
    state = applied.state
    abortBatch = applied.abortBatch

    if (state.status === 'redeemed') {
      const inLibrary = await ports.verifyInLibrary(input.name ?? null)
      state = reduce(
        state,
        inLibrary
          ? { type: 'libraryConfirmed' }
          : { type: 'libraryMissing', detail: input.name ?? '(无名)' },
      ).state
    }

    const canRetry = retryable && state.status === 'needs_human' && state.attempts < maxAttempts
    if (!canRetry) break
    // 自动重试：先回到待提交，否则 attempts 不会累加、会无限重试。
    state = reduce(state, { type: 'retry' }).state
  }

  return finish(state, { abortBatch, retryable, keyId: input.keyId, ports })
}

async function finish(
  state: RedeemState,
  ctx: { abortBatch: boolean; retryable: boolean; keyId: number; ports: RedeemPorts },
): Promise<RedeemOutcome> {
  const result: RedeemOutcome = {
    status: state.status,
    abortBatch: ctx.abortBatch,
    retryable: ctx.retryable,
    attempts: state.attempts,
    note: state.note,
  }
  try {
    await ctx.ports.record({ keyId: ctx.keyId, status: state.status, note: state.note })
  } catch (error) {
    result.recordError = error instanceof Error ? error.message : String(error)
  }
  return result
}
