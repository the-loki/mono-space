/**
 * `RedeemPorts` 的真实实现（规格 #12 §6.1）。
 *
 * 把「页面交互」与「台账落盘」接到编排上：
 * - 页面交互走 `CommandChannel`（扩展在页面里执行，主进程只发意图）；
 * - 成功判据是 **My Library 出现该 listing**，不是页面提示。
 *
 * 选择器与页面流程住在扩展里（`extension/content.js`），本文件不碰 DOM。
 */
import type { LedgerRepository } from '../data/repository'
import { ChannelTimeoutError, type CommandChannel } from './channel'
import type { RedeemPorts, SubmitOutcome } from './flow'
import { findListing } from './library-check'
import { type ExtensionReport, toSubmitOutcome } from './parse-report'

export interface RedeemDriverOptions {
  channel: CommandChannel
  repository: LedgerRepository
  keyId: number
  /** 期望入库的商品名（用于 My Library 校验）。 */
  productName?: string | null
  /** 单条命令超时（人工介入时页面会停着，给足时间）。默认 60s。 */
  timeoutMs?: number
}

/** 扩展回执里 library 命令的数据形态。 */
interface LibraryPayload {
  titles?: string[]
}

export function createRedeemPorts(options: RedeemDriverOptions): RedeemPorts {
  const { channel, repository, keyId } = options
  const timeoutMs = options.timeoutMs ?? 60_000
  let lastTitles: string[] = []

  return {
    async precheck(code) {
      if (!code.trim()) return { ok: false, detail: '兑换码为空' }
      try {
        const result = await channel.request<{ loggedIn?: boolean; onPage?: boolean }>(
          'precheck',
          { code },
          timeoutMs,
        )
        if (!result?.loggedIn) return { ok: false, detail: '未登录 Epic 账号' }
        if (!result?.onPage) return { ok: false, detail: '未停在兑换页' }
        return { ok: true }
      } catch (error) {
        const detail =
          error instanceof ChannelTimeoutError ? '预检超时（登录或人机校验未完成）' : String(error)
        return { ok: false, detail }
      }
    },

    async submit(code): Promise<SubmitOutcome> {
      try {
        const report = await channel.request<ExtensionReport>('redeem', { code }, timeoutMs)
        return toSubmitOutcome(report)
      } catch (error) {
        if (error instanceof ChannelTimeoutError) {
          // 超时 = 人在环路（验证码/确认条款/陌生页），交人工而不是当失败。
          return { page: 'human', message: '等待人工完成页面步骤超时' }
        }
        return { page: 'unknown', message: String(error) }
      }
    },

    async verifyInLibrary(name) {
      const expected = name ?? options.productName ?? null
      try {
        const payload = await channel.request<LibraryPayload>(
          'library-titles',
          undefined,
          timeoutMs,
        )
        lastTitles = payload?.titles ?? []
      } catch {
        // 库页读不到就当「未确认」——绝不把读失败当成功。
        lastTitles = []
      }
      return findListing(lastTitles, expected)
    },

    async record({ status }) {
      repository.setRedeemStatus(keyId, status)
    },
  }
}
