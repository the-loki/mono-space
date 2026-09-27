/**
 * 兑换结果登记（ADR-0005）：真正的提交由 agent 在页面上完成，宿主只负责把结果
 * **写进台账**并**记审计**。这里用真的内存台账 + 捕获审计落盘来钉住这两点。
 *
 * Electron 只用到 `app.getPath`，整体 mock；审计落盘 mock 成把每行收起来。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  repo: undefined as unknown,
  auditLines: [] as string[],
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/monospace-host-ledger-test' } }))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async (_path: string, data: string) => {
    state.auditLines.push(data)
  }),
}))

vi.mock('../../ipc/ledger', () => ({ ledgerRepository: () => state.repo }))

import { type LedgerRepository, openLedger } from '../../data/repository'
import type { SyncedOrder } from '../../data/types'
import { createAuditLogger } from '../host-audit'
import { createLedgerHost } from '../host-ledger'

/** 造一条含一个 key 的订单。 */
function seedOrder(): SyncedOrder {
  return {
    remoteId: 'order-1',
    productName: '示例订单',
    bundles: [
      {
        remoteId: 'bundle-1',
        name: '示例包',
        keys: [{ remoteId: 'key-1', name: '示例资产' }],
      },
    ],
  }
}

describe('key_redeem：登记兑换结果（不提交）', () => {
  let repo: LedgerRepository

  beforeEach(() => {
    state.auditLines.length = 0
    repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([seedOrder()])
    state.repo = repo
  })

  it('把结果写进台账，并记一条审计', async () => {
    const host = createLedgerHost(createAuditLogger())
    const keyId = repo.listKeys().items[0]?.id as number

    const result = await host.keyRedeem({ keyId, status: 'redeemed', note: '页面显示成功' })

    expect(result).toMatchObject({ ok: true, keyId, status: 'redeemed' })
    expect(repo.getKey(keyId)?.redeemStatus).toBe('redeemed')
    const audit = state.auditLines.join('')
    expect(audit).toContain('"tool":"key_redeem"')
    expect(audit).toContain('"status":"redeemed"')
    expect(audit).toContain('页面显示成功')
  })

  it('找不到该 key 时不写、并如实回报', async () => {
    const host = createLedgerHost(createAuditLogger())

    const result = await host.keyRedeem({ keyId: 999, status: 'invalid' })

    expect(result.ok).toBe(false)
    expect(result.note).toContain('999')
    expect(state.auditLines.join('')).toContain('"written":0')
  })

  it('状态不合法时直接报错，不把脏状态写进台账', async () => {
    const host = createLedgerHost(createAuditLogger())
    const keyId = repo.listKeys().items[0]?.id as number

    await expect(host.keyRedeem({ keyId, status: 'whatever' as never })).rejects.toThrow(
      '未知的兑换状态',
    )
    expect(repo.getKey(keyId)?.redeemStatus).toBe('not_redeemed')
  })
})
