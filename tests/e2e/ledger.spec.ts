import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'
import { openLedger } from '../../src/main/data/repository'
import type { SyncedKey, SyncedOrder } from '../../src/main/data/types'
import { LEDGER_ROW_HEIGHT } from '../../src/renderer/src/ledger/window'

/**
 * 台账 UI e2e：真实临时库（2000 条）→ 虚拟滚动 + 三态筛选 + 状态双列 + 不泄露兑换码明文。
 * 造数直接用数据层仓储写进 MS_LEDGER_DB 指向的库，再启动应用读取。
 */

/** 造数结果：各筛选的期望总数，以及一条真实存在于库中的兑换码明文。 */
interface SeedResult {
  total: number
  unrevealed: number
  revealedUnredeemed: number
  redeemed: number
  /** 库里确实存在的兑换码明文（用于证明「页面不含明文」不是空转）。 */
  sampleCode: string
}

const ORDERS = 20
const KEYS_PER_ORDER = 100

/** evaluate 里断言的 IPC 返回形状（node 项目里看不到 preload.d.ts 的 window 增强）。 */
interface LedgerListProbe {
  items: Record<string, unknown>[]
}

/** 造 ORDERS × KEYS_PER_ORDER 条 key：按索引均匀分布三种状态。 */
function seedLedger(dbPath: string): SeedResult {
  const orders: SyncedOrder[] = []
  const counts = { total: 0, unrevealed: 0, revealedUnredeemed: 0, redeemed: 0 }

  for (let orderIndex = 0; orderIndex < ORDERS; orderIndex += 1) {
    const keys: SyncedKey[] = []
    for (let offset = 0; offset < KEYS_PER_ORDER; offset += 1) {
      const index = orderIndex * KEYS_PER_ORDER + offset
      // 索引 % 3 == 0：未揭示；其余已揭示，其中偶数索引已兑换。
      const revealed = index % 3 !== 0
      const redeemed = revealed && index % 2 === 0
      keys.push({
        remoteId: `key-${index}`,
        name: `资产 ${index}`,
        revealStatus: revealed ? 'revealed' : 'unrevealed',
        redeemStatus: redeemed ? 'redeemed' : 'not_redeemed',
        redeemCode: revealed ? `SECRET-CODE-${index}` : null,
      })
      counts.total += 1
      if (!revealed) counts.unrevealed += 1
      else if (redeemed) counts.redeemed += 1
      else counts.revealedUnredeemed += 1
    }
    orders.push({
      remoteId: `order-${orderIndex}`,
      productName: `订单 ${orderIndex}`,
      purchasedAt: '2026-01-01T00:00:00.000Z',
      bundles: [
        {
          remoteId: `bundle-${orderIndex}`,
          name: `包 ${orderIndex}`,
          engine: 'unity',
          keys,
        },
      ],
    })
  }

  const repo = openLedger({ path: dbPath })
  repo.applyOrderSync(orders)
  const firstRevealed = repo.listKeys({ view: 'revealed_unredeemed', limit: 1 }).items[0]
  const sampleCode = firstRevealed ? (repo.getKey(firstRevealed.id)?.redeemCode ?? '') : ''
  repo.close()

  return { ...counts, sampleCode }
}

/** 用临时库启动应用。 */
function launchApp(dbPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ['out/main/index.js', '--no-sandbox'],
    env: {
      ...process.env,
      MS_TEST: '1',
      MS_LEDGER_DB: dbPath,
      DISPLAY: process.env.DISPLAY || ':198',
    },
  })
}

/** 建一个临时目录 + 库路径。 */
function tempLedger(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ms-ledger-'))
  return { dir, dbPath: join(dir, 'ledger.sqlite') }
}

test('台账列表：虚拟滚动、三态筛选、状态双列，且不含兑换码明文', async () => {
  const { dir, dbPath } = tempLedger()
  const seed = seedLedger(dbPath)
  expect(seed.sampleCode).toMatch(/^SECRET-CODE-/)
  expect(seed.total).toBe(ORDERS * KEYS_PER_ORDER)

  const app = await launchApp(dbPath)
  try {
    const page = await app.firstWindow()
    const rows = page.locator('[data-testid="ledger-row"]')

    const renderedIds = (): Promise<(string | null)[]> =>
      rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-key-id')))

    // 首屏：总数正确，且只挂载窗口内的行（远小于总数）。
    await expect(page.getByTestId('ledger-total')).toHaveText(`共 ${seed.total} 条`)
    await expect(rows.first()).toBeVisible()
    await expect
      .poll(async () => {
        const ids = await renderedIds()
        return ids.length > 5 && ids.every((id) => id !== null)
      })
      .toBe(true)
    const renderedRows = await rows.count()
    expect(renderedRows).toBeGreaterThan(5)
    expect(renderedRows).toBeLessThan(seed.total)

    // 状态双列都在首行可见。
    await expect(rows.first().locator('[data-testid="reveal-status"]')).toBeVisible()
    await expect(rows.first().locator('[data-testid="redeem-status"]')).toBeVisible()

    const allIds = await renderedIds()

    // 滚到底：占位高度等于全量行高，窗口仍只挂载少量行，且末页数据能取回。
    await page.locator('[data-testid="ledger-list"]').evaluate((node) => {
      node.scrollTop = node.scrollHeight
    })
    await expect.poll(renderedIds).toContain(String(seed.total))
    expect(await rows.count()).toBeLessThan(seed.total)
    const canvasHeight = await page
      .locator('[data-testid="ledger-canvas"]')
      .evaluate((node) => node.getBoundingClientRect().height)
    expect(canvasHeight).toBeGreaterThanOrEqual(seed.total * LEDGER_ROW_HEIGHT - 1)

    // 列表不预加载兑换码明文：整页 HTML 不含任何码，但库里确实有码。
    const html = await page.content()
    expect(html).not.toContain('SECRET-CODE-')
    expect(html).not.toContain(seed.sampleCode)

    // IPC 契约：列表结果项里压根没有兑换码字段（主进程白名单投影）。
    const payload = await page.evaluate(() => {
      const api = (
        globalThis as unknown as {
          api: { ledger: { list: (query: { limit: number }) => Promise<LedgerListProbe> } }
        }
      ).api
      return api.ledger.list({ limit: 5 })
    })
    expect(payload.items).toHaveLength(5)
    expect(payload.items.some((item) => Object.hasOwn(item, 'redeemCode'))).toBe(false)

    // 筛选「未揭示」：总数与内容都变，且每行揭示状态正确。
    await page.locator('[data-testid="ledger-filter"][data-filter="unrevealed"]').click()
    await expect(page.getByTestId('ledger-total')).toHaveText(`共 ${seed.unrevealed} 条`)
    await expect(rows.first()).toHaveAttribute('data-reveal-status', 'unrevealed')
    // 等窗口内所有行都换成新筛选的数据，再比对 id 集合。
    await expect
      .poll(async () => {
        const nodes = await rows.evaluateAll((all) =>
          all.map((node) => node.getAttribute('data-reveal-status')),
        )
        return nodes.length > 5 && nodes.every((status) => status === 'unrevealed')
      })
      .toBe(true)
    const unrevealedIds = await renderedIds()
    expect(unrevealedIds).not.toEqual(allIds)
    expect(await page.content()).not.toContain('SECRET-CODE-')

    // 筛选「已揭示未兑换」。
    await page.locator('[data-testid="ledger-filter"][data-filter="revealed_unredeemed"]').click()
    await expect(page.getByTestId('ledger-total')).toHaveText(`共 ${seed.revealedUnredeemed} 条`)
    await expect(rows.first()).toHaveAttribute('data-reveal-status', 'revealed')
    await expect(rows.first()).toHaveAttribute('data-redeem-status', 'not_redeemed')

    // 筛选「已兑换」：每行兑换状态都是 redeemed。
    await page.locator('[data-testid="ledger-filter"][data-filter="redeemed"]').click()
    await expect(page.getByTestId('ledger-total')).toHaveText(`共 ${seed.redeemed} 条`)
    await expect(rows.first()).toHaveAttribute('data-redeem-status', 'redeemed')
    const redeemedFirstId = await rows.first().getAttribute('data-key-id')
    expect(redeemedFirstId).not.toBe(unrevealedIds[0])

    // 切回全部。
    await page.locator('[data-testid="ledger-filter"][data-filter="all"]').click()
    await expect(page.getByTestId('ledger-total')).toHaveText(`共 ${seed.total} 条`)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空台账：显示空态而不是列表', async () => {
  const { dir, dbPath } = tempLedger()
  // 只建库、不写数据。
  openLedger({ path: dbPath }).close()

  const app = await launchApp(dbPath)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('ledger-empty')).toBeVisible()
    await expect(page.getByTestId('ledger-total')).toHaveText('共 0 条')
    await expect(page.locator('[data-testid="ledger-row"]')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
