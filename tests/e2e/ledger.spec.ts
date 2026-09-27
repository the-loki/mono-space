import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'
import { openLedger } from '../../src/main/data/repository'
import type { SyncedKey, SyncedOrder } from '../../src/main/data/types'
import { LEDGER_ROW_HEIGHT } from '../../src/renderer/src/ledger/window'

/**
 * 台账 UI e2e：主视图（订单列表）→ 单订单明细（真实临时库 3900 条 key）。
 * 明细内验证虚拟滚动 + 四态筛选 + 状态双列 + 不泄露兑换码明文。
 *
 * 造数直接用数据层仓储写进 MS_LEDGER_DB 指向的库，再启动应用读取。
 * ADR-0003 后一进界面是订单列表，key 相关断言必须先点进某一单的明细；
 * 第 0 单特意放大到 2000 条，保证「单订单明细」也在原规模上验证虚拟滚动。
 */

/** 单个订单在四种筛选下的期望条数。 */
interface OrderCounts {
  total: number
  unrevealed: number
  revealedUnredeemed: number
  redeemed: number
}

/** 造数结果：每个订单的期望条数，以及几条真实存在于库中的值。 */
interface SeedResult {
  /** 与 ORDERS 等长，下标即 orderIndex。 */
  perOrder: OrderCounts[]
  /** 全库 key 合计（校验造数没写错）。 */
  totalKeys: number
  /** 第 0 单最后一条 key 的库内 id（滚到底应能取回它）。 */
  lastKeyId: string
  /** 库里确实存在的兑换码明文（用于证明「页面不含明文」不是空转）。 */
  sampleCode: string
}

const ORDERS = 20
/** 第 0 单特意放大：单订单明细也要按原规模（2000 条）验证虚拟滚动。 */
const FIRST_ORDER_KEYS = 2000
/** 其余订单各 100 条。 */
const KEYS_PER_ORDER = 100

/** evaluate 里断言的 IPC 返回形状（node 项目里看不到 preload.d.ts 的 window 增强）。 */
interface LedgerListProbe {
  items: Record<string, unknown>[]
}

/** evaluate 里用到的 window.api 子集。 */
interface LedgerApiProbe {
  list(query: { limit: number; orderRemoteId: string }): Promise<LedgerListProbe>
}

/** 造 ORDERS 单：全库 key 按索引均匀分布三种状态。 */
function seedLedger(dbPath: string): SeedResult {
  const orders: SyncedOrder[] = []
  const perOrder: OrderCounts[] = []
  // 全库递增的 key 索引（决定状态分布，与订单切分无关）。
  let index = 0

  for (let orderIndex = 0; orderIndex < ORDERS; orderIndex += 1) {
    const keyCount = orderIndex === 0 ? FIRST_ORDER_KEYS : KEYS_PER_ORDER
    const keys: SyncedKey[] = []
    const counts: OrderCounts = { total: 0, unrevealed: 0, revealedUnredeemed: 0, redeemed: 0 }

    for (let offset = 0; offset < keyCount; offset += 1) {
      // 索引 % 3 == 0：未揭示；其余已揭示，其中偶数索引已兑换。
      const revealed = index % 3 !== 0
      const redeemed = revealed && index % 2 === 0
      keys.push({
        remoteId: `key-${index}`,
        name: `资产 ${index}`,
        revealStatus: revealed ? 'revealed' : 'unrevealed',
        redeemStatus: redeemed ? 'redeemed' : 'not_redeemed',
        redeemCode: revealed ? `SECRET-CODE-${index}` : null,
        // 只给**一行没有码的 key** 带无码缘由（fixture 追加字段，不改既有造数与断言）：
        // 界面应在明细里出徽章，有码的行不出。key-0 是未揭示（无码）的第一行。
        noCodeReason: !revealed && index === 0 ? 'expired' : null,
      })
      counts.total += 1
      if (!revealed) counts.unrevealed += 1
      else if (redeemed) counts.redeemed += 1
      else counts.revealedUnredeemed += 1
      index += 1
    }

    perOrder.push(counts)
    orders.push({
      remoteId: `order-${orderIndex}`,
      productName: `订单 ${orderIndex}`,
      bundles: [
        {
          remoteId: `bundle-${orderIndex}`,
          name: `包 ${orderIndex}`,
          keys,
        },
      ],
    })
  }

  const repo = openLedger({ path: dbPath })
  repo.applyOrderSync(orders)
  const sampleKey = repo.listKeys({ view: 'revealed_unredeemed', limit: 1 }).items[0]
  const sampleCode = sampleKey ? (repo.getKey(sampleKey.id)?.redeemCode ?? '') : ''
  // 第 0 单最后一条 key 的库内 id：滚到底时窗口末行应当是它。
  const lastKey = repo.listKeys({
    orderRemoteId: 'order-0',
    offset: FIRST_ORDER_KEYS - 1,
    limit: 1,
  }).items[0]
  repo.close()

  return {
    perOrder,
    totalKeys: perOrder.reduce((sum, counts) => sum + counts.total, 0),
    lastKeyId: String(lastKey?.id ?? ''),
    sampleCode,
  }
}

/** 用临时库启动应用。 */
function launchApp(
  dbPath: string,
  extraEnv: Record<string, string> = {},
): Promise<ElectronApplication> {
  return electron.launch({
    args: ['out/main/index.js', '--no-sandbox'],
    env: {
      ...process.env,
      MS_TEST: '1',
      MS_LEDGER_DB: dbPath,
      DISPLAY: process.env.DISPLAY || ':198',
      ...extraEnv,
    },
  })
}

/** 建一个临时目录 + 库路径。 */
function tempLedger(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ms-ledger-'))
  return { dir, dbPath: join(dir, 'ledger.sqlite') }
}

test('订单主视图 + 单订单明细：虚拟滚动、四态筛选、状态双列，且不含兑换码明文', async () => {
  const { dir, dbPath } = tempLedger()
  const seed = seedLedger(dbPath)
  expect(seed.sampleCode).toMatch(/^SECRET-CODE-/)
  expect(seed.totalKeys).toBe(FIRST_ORDER_KEYS + (ORDERS - 1) * KEYS_PER_ORDER)

  const app = await launchApp(dbPath)
  try {
    const page = await app.firstWindow()
    const orderRows = page.locator('[data-testid="order-row"]')
    const rows = page.locator('[data-testid="ledger-row"]')

    const renderedIds = (): Promise<(string | null)[]> =>
      rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-key-id')))

    // 主视图：一单一行（不是 key 列表），key 计数在进明细前就显示。
    await expect(page.getByTestId('orders-total')).toHaveText(`共 ${ORDERS} 单`)
    await expect(orderRows).toHaveCount(ORDERS)

    const first = seed.perOrder[0]
    // 明细必须真的是 2000 条规模，否则虚拟滚动断言就是空转。
    expect(first.total).toBe(FIRST_ORDER_KEYS)
    // 未揭示数 >0 才有徒章可断言（否则下面那条是空转）。
    expect(first.unrevealed).toBeGreaterThan(0)
    const firstOrder = orderRows.first()
    // key 计数与未揭示数分两处显示：计数常显（只有总数），未揭示数只在 >0 时出橙色徒章。
    await expect(firstOrder.locator('[data-testid="order-key-count"]')).toHaveText(
      `${first.total} 个 key`,
    )
    await expect(firstOrder.locator('[data-testid="order-unrevealed"]')).toHaveText(
      `未揭示 ${first.unrevealed}`,
    )
    // 计数里不再带「未揭示」——否则 68 行都写「·0 个未揭示」，「该动哪一单」就淹掉了。
    await expect(firstOrder.locator('[data-testid="order-key-count"]')).not.toContainText('未揭示')

    // 整行可点：点商品名（非按钮区域）也能进该单明细。
    await firstOrder.getByText('订单 0', { exact: true }).click()
    await expect(page.getByTestId('order-back')).toBeVisible()
    await expect(page.getByTestId('order-title')).toHaveText('订单 0')
    await expect(page.getByTestId('ledger-total')).toHaveText(`共 ${first.total} 条`)

    // 明细首屏：只挂载窗口内的行（远小于本单总数）。
    await expect(rows.first()).toBeVisible()
    await expect
      .poll(async () => {
        const ids = await renderedIds()
        return ids.length > 5 && ids.every((id) => id !== null)
      })
      .toBe(true)
    const renderedRows = await rows.count()
    expect(renderedRows).toBeGreaterThan(5)
    expect(renderedRows).toBeLessThan(first.total)

    // 状态双列都在首行可见。
    await expect(rows.first().locator('[data-testid="reveal-status"]')).toBeVisible()
    await expect(rows.first().locator('[data-testid="redeem-status"]')).toBeVisible()

    // 无码缘由：fixture 里只有 key-0 那一行**没有码**、带 'expired'；界面在该行出徽章。
    const reasonBadge = page.locator('[data-testid="key-no-code-reason"]')
    await expect(reasonBadge).toHaveCount(1)
    await expect(reasonBadge).toHaveAttribute('data-reason', 'expired')
    await expect(reasonBadge).toHaveText('已过期')
    // 徽章挂在**未揭示（无码）**的那一行上。
    await expect(rows.first()).toHaveAttribute('data-reveal-status', 'unrevealed')
    await expect(rows.first().locator('[data-testid="key-no-code-reason"]')).toBeVisible()
    // 有码的行**不出**这个徽章：第二行已揭示、有兑换码。
    await expect(rows.nth(1).locator('[data-testid="key-no-code-reason"]')).toHaveCount(0)

    const allIds = await renderedIds()

    // IPC 契约：列表结果项里压根没有兑换码字段（主进程白名单投影）。
    const payload = await page.evaluate(async () => {
      const api = (globalThis as unknown as { api: { ledger: LedgerApiProbe } }).api
      return api.ledger.list({ orderRemoteId: 'order-0', limit: 5 })
    })
    expect(payload.items).toHaveLength(5)
    expect(payload.items.some((item) => Object.hasOwn(item, 'redeemCode'))).toBe(false)

    // 滚到底：占位高度等于本单全量行高，窗口仍只挂载少量行，且末页数据能取回。
    await page.locator('[data-testid="ledger-list"]').evaluate((node) => {
      node.scrollTop = node.scrollHeight
    })
    await expect.poll(renderedIds).toContain(seed.lastKeyId)
    expect(await rows.count()).toBeLessThan(first.total)
    const canvasHeight = await page
      .locator('[data-testid="ledger-canvas"]')
      .evaluate((node) => node.getBoundingClientRect().height)
    expect(canvasHeight).toBeGreaterThanOrEqual(first.total * LEDGER_ROW_HEIGHT - 1)

    // 列表不预加载兑换码明文：整页 HTML 不含任何码，但库里确实有码。
    const html = await page.content()
    expect(html).not.toContain('SECRET-CODE-')
    expect(html).not.toContain(seed.sampleCode)

    // 筛选「未揭示」：总数与内容都变，且每行揭示状态正确。
    await page.locator('[data-testid="ledger-filter"][data-filter="unrevealed"]').click()
    await expect(page.getByTestId('ledger-total')).toHaveText(`共 ${first.unrevealed} 条`)
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
    await expect(page.getByTestId('ledger-total')).toHaveText(`共 ${first.revealedUnredeemed} 条`)
    await expect(rows.first()).toHaveAttribute('data-reveal-status', 'revealed')
    await expect(rows.first()).toHaveAttribute('data-redeem-status', 'not_redeemed')

    // 筛选「已兑换」：每行兑换状态都是 redeemed。
    await page.locator('[data-testid="ledger-filter"][data-filter="redeemed"]').click()
    await expect(page.getByTestId('ledger-total')).toHaveText(`共 ${first.redeemed} 条`)
    await expect(rows.first()).toHaveAttribute('data-redeem-status', 'redeemed')
    const redeemedFirstId = await rows.first().getAttribute('data-key-id')
    expect(redeemedFirstId).not.toBe(unrevealedIds[0])

    // 切回全部。
    await page.locator('[data-testid="ledger-filter"][data-filter="all"]').click()
    await expect(page.getByTestId('ledger-total')).toHaveText(`共 ${first.total} 条`)

    // 返回订单主视图。
    await page.getByTestId('order-back').click()
    await expect(page.getByTestId('orders-total')).toHaveText(`共 ${ORDERS} 单`)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空台账：订单主视图显示空态而不是列表', async () => {
  const { dir, dbPath } = tempLedger()
  // 只建库、不写数据。
  openLedger({ path: dbPath }).close()

  const app = await launchApp(dbPath)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('orders-empty')).toBeVisible()
    await expect(page.getByTestId('orders-total')).toHaveText('共 0 单')
    await expect(page.locator('[data-testid="order-row"]')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('订单无 key：明细显示空态而不是列表', async () => {
  const { dir, dbPath } = tempLedger()
  // 只有订单、没有 key：同步只建订单，key 要靠页面上读（ADR-0003）。
  const repo = openLedger({ path: dbPath })
  repo.applyOrderSync([{ remoteId: 'order-empty', productName: '空订单', bundles: [] }])
  repo.close()

  const app = await launchApp(dbPath)
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('orders-total')).toHaveText('共 1 单')
    await page.locator('[data-testid="order-open-detail"]').first().click()
    await expect(page.getByTestId('ledger-empty')).toBeVisible()
    await expect(page.getByTestId('ledger-total')).toHaveText('共 0 条')
    await expect(page.locator('[data-testid="ledger-row"]')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 导出落盘：`docs/verify/33-full-test.md` §0 问题 1 记录过「导出算完文本就被丢掉」的真 bug。
 * 原生保存对话框没法无头点，所以用仓库既有的测试缝模式（`MS_EXPORT_DIR`，同 `MS_LEDGER_DB`）：
 * 指定目录时不弹对话框，直接落盘 —— 这样「导出到底有没有写出文件」才真的被 e2e 钉住。
 */
test('导出 JSON / CSV：真的落盘到指定目录，且文件内容正确（列表却仍不含码）', async () => {
  const { dir, dbPath } = tempLedger()
  const exportDir = join(dir, 'exports')
  mkdirSync(exportDir)
  const repo = openLedger({ path: dbPath })
  repo.applyOrderSync([
    {
      remoteId: 'order-export',
      productName: '导出用订单',
      bundles: [
        {
          remoteId: 'order-export_page',
          name: '导出用包',
          keys: [
            {
              remoteId: 'key-0',
              name: '资产 0',
              revealStatus: 'revealed',
              redeemStatus: 'not_redeemed',
              redeemCode: 'EXPORT-SECRET-0',
            },
            {
              remoteId: 'key-1',
              name: '资产 1',
              revealStatus: 'unrevealed',
              redeemStatus: 'not_redeemed',
              noCodeReason: 'expired',
            },
          ],
        },
      ],
    },
  ])
  repo.close()

  const app = await launchApp(dbPath, { MS_EXPORT_DIR: exportDir })
  try {
    const page = await app.firstWindow()
    const note = page.getByTestId('ledger-export-note')

    // JSON：点一下就该有文件，且提示写出路径。
    await page.locator('[data-testid="ledger-export-json"]').click()
    await expect(note).toContainText('已保存到')
    await expect(note).toContainText(exportDir)
    const jsonFiles = readdirSync(exportDir).filter((name) => name.endsWith('.json'))
    expect(jsonFiles).toHaveLength(1)
    expect(jsonFiles[0]).toMatch(/^monospace-ledger-\d{4}-\d{2}-\d{2}\.json$/)
    const parsed = JSON.parse(readFileSync(join(exportDir, jsonFiles[0]!), 'utf8')) as {
      version?: number
      orders?: {
        bundles?: { keys?: { redeemCode?: string | null; noCodeReason?: string | null }[] }[]
      }[]
    }
    // 导出的是「订单 → 包 → key」嵌套结构（`parseLedgerJson` 的往返格式），不是扁平 keys 数组。
    const rows = (parsed.orders ?? []).flatMap((order) =>
      (order.bundles ?? []).flatMap((bundle) => bundle.keys ?? []),
    )
    expect(rows).toHaveLength(2)
    // 导出**是**要带码的（这是导出的用途）；列表不带动是另一条约束，两者不矛盾。
    expect(rows.some((row) => row.redeemCode === 'EXPORT-SECRET-0')).toBe(true)
    // 无码缘由也进导出：导出台账却不说哪行没码、为什么没码，正是用户要这个功能的原因。
    expect(rows.some((row) => row.noCodeReason === 'expired')).toBe(true)

    // CSV：另一个文件，表头正确。
    await page.locator('[data-testid="ledger-export-csv"]').click()
    await expect(note).toContainText('已保存到')
    const csvFiles = readdirSync(exportDir).filter((name) => name.endsWith('.csv'))
    expect(csvFiles).toHaveLength(1)
    const csv = readFileSync(join(exportDir, csvFiles[0]!), 'utf8')
    expect(csv.split('\n')[0]).toContain('redeemCode')
    expect(csv).toContain('EXPORT-SECRET-0')

    // 同一页面上，列表依旧不预加载兑换码明文（导出的文件里有，界面里没有）。
    expect(await page.content()).not.toContain('EXPORT-SECRET-0')
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 同单同名带码提示：页面行标「未揭示」不代表台账里没这个资产的码。
 * 真实库 46 条未揭示里 27 条的同单同名补充行持有码（`docs/verify/34`），
 * 用户看到「未揭示」会白跑一次揭示 —— 所以给一句提示，**但不合并数据**（连接键只能是兑换码）。
 */
test('同单同名带码：无码行出提示、计数正确；没有同名带码行则不出提示', async () => {
  const { dir, dbPath } = tempLedger()
  const repo = openLedger({ path: dbPath })
  repo.applyOrderSync([
    {
      remoteId: 'order-same-name',
      productName: '同名提示订单',
      bundles: [
        {
          remoteId: 'order-same-name_page',
          name: '包',
          keys: [
            // ① 无码页行 + ② 同单同名带码行（接口补充行）⇒ ① 应出「同名行带码 ×1」
            {
              remoteId: 'k-nocode',
              name: '素材 A',
              revealStatus: 'unrevealed',
              noCodeReason: 'link_only',
            },
            {
              remoteId: 'api:supp',
              name: '素材 A',
              revealStatus: 'revealed',
              redeemStatus: 'not_redeemed',
              redeemCode: 'SAME-NAME-CODE',
            },
            // ③ 无码但没有同名带码行 ⇒ 不应出提示
            {
              remoteId: 'k-lonely',
              name: '素材 B',
              revealStatus: 'unrevealed',
              noCodeReason: 'expired',
            },
          ],
        },
      ],
    },
  ])
  repo.close()

  const app = await launchApp(dbPath)
  try {
    const page = await app.firstWindow()
    await page.locator('[data-testid="order-open-detail"]').first().click()

    const rows = page.locator('[data-testid="ledger-row"]')
    await expect(rows).toHaveCount(3)

    const badge = page.locator('[data-testid="key-same-name-code"]')
    await expect(badge).toHaveCount(1)
    await expect(badge).toHaveText('同名行带码 ×1')
    await expect(badge).toHaveAttribute('data-count', '1')
    await expect(badge).toHaveAttribute('title', /同名且已有兑换码/)

    // 它挂在「素材 A」的无码行上，不在「素材 B」那行。
    const owner = rows.filter({ has: page.locator('[data-testid="key-same-name-code"]') })
    await expect(owner).toHaveCount(1)
    await expect(owner.first()).toContainText('素材 A')
    const lonely = rows.filter({ hasText: '素材 B' })
    await expect(lonely.locator('[data-testid="key-same-name-code"]')).toHaveCount(0)

    // 提示只是提示：**列表里依旧没有兑换码明文**（SAME-NAME-CODE 只在库里）。
    expect(await page.content()).not.toContain('SAME-NAME-CODE')
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
