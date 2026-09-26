/**
 * `RevealPorts` 的真实实现（`#25`）。
 *
 * 页面交互全部走 `CommandChannel`（扩展在 humblebundle.com 页面上下文里 fetch，
 * 才能过 Cloudflare —— 见 `docs/research/humble-reveal.md` §4.1）。
 * 不可逆写操作只有 `submit` 一处，且必须先过只读 `probe`。
 */
import type { LedgerRepository } from '../data/repository'
import { ChannelTimeoutError, type CommandChannel } from '../redeem/channel'
import type { PrecheckResult, ProbeResult, RevealInput, RevealPorts } from './flow'
import { parseRevealResponse, type RevealResponse } from './outcome'

export interface RevealDriverOptions {
  channel: CommandChannel
  repository: LedgerRepository
  /** 单条命令超时；人工过登录/验证码时给足时间。默认 120s。 */
  timeoutMs?: number
}

interface PrecheckPayload {
  loggedIn?: boolean
  onPage?: boolean
}

export function createRevealPorts(options: RevealDriverOptions): RevealPorts {
  const { channel, repository } = options
  const timeoutMs = options.timeoutMs ?? 120_000

  return {
    async precheck(input: RevealInput): Promise<PrecheckResult> {
      try {
        const result = await channel.request<PrecheckPayload>('reveal-precheck', input, timeoutMs)
        if (!result?.loggedIn) return { ok: false, detail: '未登录 Humble', pause: 'login' }
        if (!result?.onPage)
          return { ok: false, detail: '不在 humblebundle.com', pause: 'unknown-page' }
        return { ok: true }
      } catch (error) {
        if (error instanceof ChannelTimeoutError) {
          return { ok: false, detail: '预检超时（可能停在登录/人机校验）', pause: 'login' }
        }
        return { ok: false, detail: String(error), pause: 'unknown-page' }
      }
    },

    async probe(input: RevealInput): Promise<ProbeResult> {
      try {
        const result = await channel.request<ProbeResult>('reveal-probe', input, timeoutMs)
        // 扩展只回三种形态之一；未知形态一律当不可用（保守）。
        if (result?.kind === 'needs-reveal' || result?.kind === 'already-revealed') return result
        if (result?.kind === 'unavailable') return result
        return { kind: 'unavailable', detail: '试探回执形态未知', pause: 'unknown-page' }
      } catch (error) {
        const detail = error instanceof ChannelTimeoutError ? '试探超时' : String(error)
        return { kind: 'unavailable', detail, pause: 'unknown-page' }
      }
    },

    async submit(input: RevealInput) {
      const raw = await channel.request<RevealResponse>('reveal-post', input, timeoutMs)
      return parseRevealResponse(raw ?? {})
    },

    async reRead(input: RevealInput): Promise<string | null> {
      const result = await channel.request<{ code?: string | null }>(
        'reveal-reread',
        input,
        timeoutMs,
      )
      return result?.code ?? null
    },

    async record({ keyId, code, status }) {
      // 只有真的揭示成功才动台账；暂停/耗尽保持「未揭示」。
      if (status === 'revealed' && code) repository.markRevealed(keyId, code)
    },
  }
}
