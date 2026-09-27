import { describe, expect, it, vi } from 'vitest'
import { REDEEM_STATUSES, type RedeemStatus } from '../../data/types'
import {
  createTools,
  type McpHost,
  MONOSPACE_TAG,
  REDEEM_RECORDABLE_STATUSES,
  TOOL_PREFIX,
} from '../tools'

function fakeHost(overrides: Partial<McpHost> = {}): McpHost {
  return {
    ledgerStats: vi.fn(async () => ({
      total: 10,
      unrevealed: 3,
      revealedUnredeemed: 6,
      redeemed: 1,
    })),
    ledgerQuery: vi.fn(async () => [
      {
        keyId: 1,
        name: '素材',
        bundle: 'Synty',
        order: '某单',
        revealStatus: 'unrevealed',
        redeemStatus: 'not_redeemed',
      },
    ]),
    keyContext: vi.fn(async (keyId) =>
      keyId === 1
        ? {
            keyId: 1,
            name: '素材',
            bundle: 'Synty',
            order: '某单',
            revealStatus: 'unrevealed',
            redeemStatus: 'not_redeemed',
            redeemCode: 'SECRET-CODE',
          }
        : null,
    ),
    // —— 浏览器（融合缩减后的 5 个工具背后）——
    browserOpenPage: vi.fn(async (url: string) => ({ pageId: 2, url, title: 't', selected: true })),
    browserNavigatePage: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', selected: true })),
    browserTakeSnapshot: vi.fn(async () => ({
      pageId: 1,
      url: 'u',
      title: 't',
      text: '- uid=1_0 RootWebArea "x"',
      nodeCount: 1,
      truncated: false,
    })),
    browserTakeScreenshot: vi.fn(async () => ({ pageId: 1, format: 'png', bytes: 3 })),
    browserClick: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserHover: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserDrag: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserFill: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserTypeText: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserPressKey: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserUploadFile: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserHandleDialog: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserScroll: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserEvaluateScript: vi.fn(async () => ({ value: 1 })),
    browserErrors: vi.fn(async () => ({ pageId: 1, url: 'u', errors: [], failedRequests: [] })),
    ordersSync: vi.fn(async () => ({ ok: true })),
    keysUpsert: vi.fn(async () => ({ written: 1, absorbed: 0, auditId: 'a#1' })),
    keysIngest: vi.fn(async () => ({ orders: {}, bundles: {}, keys: {} })),
    keyOpen: vi.fn(async (keyId: number) => ({
      ok: true as const,
      keyId,
      name: 'n',
      pageId: 1,
      url: 'u',
      title: 't',
    })),
    keyRedeem: vi.fn(
      async ({ keyId, status, note }: { keyId: number; status: RedeemStatus; note?: string }) => ({
        ok: true,
        keyId,
        status,
        note: note ?? '',
      }),
    ),
    ...overrides,
  }
}

function toolNamed(name: string, host: McpHost = fakeHost()) {
  const tool = createTools(host).find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`没有工具 ${name}`)
  return tool
}

describe('命名：全部 monospace_ 前缀（防与其它浏览器 MCP 撞名）', () => {
  it('所有工具都带前缀', () => {
    for (const tool of createTools(fakeHost())) {
      expect(tool.name.startsWith(TOOL_PREFIX)).toBe(true)
    }
  })

  it('浏览器类工具都声明了作用范围（与其它浏览器 MCP 区分）', () => {
    const tools = createTools(fakeHost())
    // 与内置浏览器语义相关的工具（key_page_read 也会驱动内置浏览器，但不带 browser 段）。
    const browserSemantic = [
      `${TOOL_PREFIX}page_open`,
      `${TOOL_PREFIX}dom`,
      `${TOOL_PREFIX}screenshot`,
      `${TOOL_PREFIX}script`,
      `${TOOL_PREFIX}act`,
      `${TOOL_PREFIX}errors`,
    ]
    // 融合缩减：浏览器接口就这 6 个（其余能力收进 act）。page_open 是**开场入口**：
    // 一个页面都没打开时，其余浏览器工具都无从下手（它们只作用于当前页面）。
    expect(
      tools.filter((tool) => tool.description.includes('MonoSpace 应用内置的浏览会话')).length,
    ).toBe(6)
    for (const name of browserSemantic) {
      const tool = tools.find((candidate) => candidate.name === name)
      expect(tool, name).toBeDefined()
      expect(tool?.description).toContain('MonoSpace 应用内置的浏览会话')
      expect(tool?.description).toContain('不是系统 Chrome')
    }
  })

  it('没有裸名工具（如 goto/snapshot/click）', () => {
    const names = createTools(fakeHost()).map((tool) => tool.name)
    for (const bare of ['goto', 'snapshot', 'click', 'navigate', 'screenshot']) {
      expect(names).not.toContain(bare)
    }
  })
})

describe('权限分层（#13）', () => {
  it('只读 / 写入 / 不可逆三层各自归位', () => {
    const tools = createTools(fakeHost())
    const layerOf = (name: string) => tools.find((t) => t.name === name)?.layer
    expect(layerOf(`${TOOL_PREFIX}ledger_stats`)).toBe('L0')
    expect(layerOf(`${TOOL_PREFIX}dom`)).toBe('L0')
    expect(layerOf(`${TOOL_PREFIX}errors`)).toBe('L0')
    expect(layerOf(`${TOOL_PREFIX}orders_sync`)).toBe('L1')
    expect(layerOf(`${TOOL_PREFIX}keys_upsert`)).toBe('L1')
    expect(layerOf(`${TOOL_PREFIX}act`)).toBe('L1')
    // key_reveal 已删除：揭示不再有硬编码工具，由 agent 在页面上完成（key_open 只开页面）。
    expect(layerOf(`${TOOL_PREFIX}key_open`)).toBe('L1')
    // key_redeem 从 L2 降到 L1：不可逆的**提交**已由 agent 在页面上完成，
    // 这个工具只是把结果**登记**回台账（写 + 留痕），留在 L2 就等于 agent 用不上。
    expect(layerOf(`${TOOL_PREFIX}key_redeem`)).toBe('L1')
  })
})

describe('parameters 是合法的 TypeBox 对象（Pi SDK 要求）', () => {
  it('act / ledger_query 暴露 object 结构，且 optional 键不进 required', () => {
    const act = toolNamed(`${TOOL_PREFIX}act`).parameters
    expect(act.type).toBe('object')
    expect(Object.keys(act.properties)).toContain('action')

    // action 必须是枚举形态：TypeBox 的 union 产出 anyOf（元素带 const），也兼容 enum 写法。
    const action = act.properties.action as { anyOf?: unknown[]; enum?: unknown[] }
    const raw = action.anyOf ?? action.enum
    expect(raw, 'action 应带 anyOf 或 enum').toBeDefined()
    const values = (raw ?? []).map((entry) =>
      entry && typeof entry === 'object' && 'const' in entry
        ? (entry as { const: unknown }).const
        : entry,
    )
    expect(values).toEqual(expect.arrayContaining(['click', 'goto', 'scroll']))
    // uid 原本是 optional，不能被标成必填。
    expect(act.required ?? []).not.toContain('uid')

    const query = toolNamed(`${TOOL_PREFIX}ledger_query`).parameters
    expect(query.type).toBe('object')
    for (const key of ['view', 'orderRemoteId', 'limit', 'offset']) {
      expect(Object.keys(query.properties)).toContain(key)
    }
    // limit / orderRemoteId 原本是 optional，不能被标成必填。
    expect(query.required ?? []).not.toContain('limit')
    expect(query.required ?? []).not.toContain('orderRemoteId')
  })
})

describe('工具行为', () => {
  it('ledger_query 转发查询参数（含按订单过滤）', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}ledger_query`, host).run({
      view: 'unrevealed',
      orderRemoteId: 'gk-1',
      limit: 10,
    })
    expect(host.ledgerQuery).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'unrevealed', orderRemoteId: 'gk-1', limit: 10 }),
    )
  })

  it('key_context 默认**不返回**兑换码明文', async () => {
    const result = (await toolNamed(`${TOOL_PREFIX}key_context`).run({ keyId: 1 })) as {
      key: Record<string, unknown>
      note: string
    }
    expect(result.key.redeemCode).toBeUndefined()
    expect(result.note).toContain('未返回')
  })

  it('key_context 显式要码才给', async () => {
    const result = (await toolNamed(`${TOOL_PREFIX}key_context`).run({
      keyId: 1,
      includeCode: true,
    })) as { key: { redeemCode?: string } }
    expect(result.key.redeemCode).toBe('SECRET-CODE')
  })

  it('key_context 找不到时不编造', async () => {
    const result = (await toolNamed(`${TOOL_PREFIX}key_context`).run({ keyId: 999 })) as {
      found: boolean
    }
    expect(result.found).toBe(false)
  })

  it('act(click) 把 uid 转发到宿主（当前页由宿主解析，见 host.test.ts）', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}act`, host).run({ action: 'click', uid: '1_5' })
    expect(host.browserClick).toHaveBeenCalledWith('1_5', { includeSnapshot: undefined })
  })

  it('act(click) 缺 uid 时给一句能照着做的错', async () => {
    const host = fakeHost()
    await expect(toolNamed(`${TOOL_PREFIX}act`, host).run({ action: 'click' })).rejects.toThrow(
      /click 需要 uid/,
    )
  })

  it('dom 作用于当前页面并转发 verbose', async () => {
    const host = fakeHost()
    const result = await toolNamed(`${TOOL_PREFIX}dom`, host).run({ verbose: true })
    expect(host.browserTakeSnapshot).toHaveBeenCalledWith({
      filePath: undefined,
      verbose: true,
    })
    expect(result).toMatchObject({ nodeCount: 1 })
  })

  it('script 转发函数与参数', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}script`, host).run({
      function: '() => document.title',
      args: [1, 'a'],
    })
    expect(host.browserEvaluateScript).toHaveBeenCalledWith('() => document.title', {
      args: [1, 'a'],
      filePath: undefined,
      waitForStableDom: undefined,
    })
  })

  it('act(goto) 转发 url', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}act`, host).run({ action: 'goto', url: 'https://example.com' })
    expect(host.browserNavigatePage).toHaveBeenCalledWith({
      type: 'url',
      url: 'https://example.com',
    })
  })

  it('act(scroll) 转发方向与像素量', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}act`, host).run({
      action: 'scroll',
      direction: 'up',
      amount: 300,
    })
    expect(host.browserScroll).toHaveBeenCalledWith('up', 300)
  })

  it('keys_upsert 转发条目', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}keys_upsert`, host).run({
      entries: [{ keyId: 1, code: 'X', revealed: true }],
    })
    expect(host.keysUpsert).toHaveBeenCalledWith([{ keyId: 1, code: 'X', revealed: true }])
  })

  it('key_open 只开页面（揭示交给 agent 自己操作，不再有硬编码揭示工具）', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}key_open`, host).run({ keyId: 3 })
    expect(host.keyOpen).toHaveBeenCalledWith(3)
    // 揭示工具必须**不存在**了：特征匹配已删除，全权交给 agent。
    expect(createTools(host).map((t) => t.name)).not.toContain(`${TOOL_PREFIX}key_reveal`)
  })

  it('兑换结果登记：转发 keyId / status / note 给宿主（不替 agent 提交）', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}key_redeem`, host).run({
      keyId: 3,
      status: 'redeemed',
      note: '页面显示成功',
    })
    expect(host.keyRedeem).toHaveBeenCalledWith({
      keyId: 3,
      status: 'redeemed',
      note: '页面显示成功',
    })
  })
})

describe('兑换结果登记 key_redeem（ADR-0005：不替 agent 提交）', () => {
  it('描述里写明是「登记」、不会替你提交、提交靠页面', () => {
    const tool = toolNamed(`${TOOL_PREFIX}key_redeem`)
    expect(tool.description).toContain('登记')
    expect(tool.description).toContain('不会替你提交')
    expect(tool.description).toContain('页面')
    // 可达层：提交在页面上由 agent 完成，登记只是写台账 + 留痕。
    expect(tool.layer).toBe('L1')
  })

  it('status 只收台账已有的兑换状态词（不发明新值）', () => {
    const parameters = toolNamed(`${TOOL_PREFIX}key_redeem`).parameters as unknown as {
      properties: { status: { anyOf?: { const?: string }[]; enum?: string[] } }
    }
    const status = parameters.properties.status
    const raw = status.anyOf ?? status.enum ?? []
    const values = raw.map((entry) => (typeof entry === 'string' ? entry : (entry.const ?? '')))
    // schema 与常量同源：两边漂移任一方向都会被抓住。
    expect(values).toEqual([...REDEEM_RECORDABLE_STATUSES])
    // 每一个都必须是台账已有的兑换状态词（不发明新值）。
    for (const value of REDEEM_RECORDABLE_STATUSES) {
      expect(REDEEM_STATUSES).toContain(value)
    }
    // 中间态不是「结果」，不暴露给 agent 登记。
    for (const transient of ['precheck', 'probing', 'redeeming']) {
      expect(values).not.toContain(transient)
    }
  })

  it('status 必填、note 可选（optional 不进 required）', () => {
    const parameters = toolNamed(`${TOOL_PREFIX}key_redeem`).parameters
    expect(parameters.required ?? []).toContain('status')
    expect(parameters.required ?? []).not.toContain('note')
  })
})

describe('脱敏：页面标题里的账号邮箱不能扩散', () => {
  it('标题里的邮箱被打码', async () => {
    const { redactAccountTitle } = await import('../host')
    expect(redactAccountTitle('Humble Bundle - 574706224@qq.com')).toBe(
      'Humble Bundle - <账号已脱敏>',
    )
    expect(redactAccountTitle('密钥和权益')).toBe('密钥和权益')
    expect(redactAccountTitle('a@b.co and c.d@e.fg')).toBe('<账号已脱敏> and <账号已脱敏>')
  })

  it('a11y 正文里的邮箱同样被打码（不只 title）', async () => {
    const { redactSnapshotText } = await import('../host')
    expect(redactSnapshotText('- RootWebArea "Humble Bundle - 574706224@qq.com"')).toBe(
      '- RootWebArea "Humble Bundle - <账号已脱敏>"',
    )
  })
})

describe('与真实浏览器 MCP 区分（用户要求强调）', () => {
  it('每一个工具的描述都以【MonoSpace】开头', () => {
    for (const spec of createTools(fakeHost())) {
      expect(spec.description.startsWith(MONOSPACE_TAG), spec.name).toBe(true)
    }
  })

  it('浏览器类工具点名了最容易混淆的对手', () => {
    const dom = createTools(fakeHost()).find((t) => t.name === `${TOOL_PREFIX}dom`)
    expect(dom?.description).toContain('Chrome DevTools MCP')
    expect(dom?.description).toContain('Playwright')
    expect(dom?.description).toContain('不是系统 Chrome')
  })

  it('作用域声明里的名字与真实浏览器 MCP 不同（避免同名同义误用）', () => {
    // Chrome DevTools MCP 用的是 click / take_snapshot / navigate_page；
    // 我们的是 act / dom / act(goto)——同义不同名，前缀也不同。
    const names = createTools(fakeHost()).map((t) => t.name)
    expect(names).not.toContain('take_snapshot')
    expect(names).not.toContain('navigate_page')
    expect(names).toContain(`${TOOL_PREFIX}dom`)
  })
})

describe('工具表完整性', () => {
  it('工具名唯一（重名会让客户端只认到一个，等于悄悄少功能）', () => {
    const names = createTools(fakeHost()).map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('浏览器接口 6 个（含开场入口 page_open），领域接口 8 个', () => {
    const tools = createTools(fakeHost())
    const browser = tools.filter((tool) => tool.description.includes('不是系统 Chrome'))
    expect(browser).toHaveLength(6)
    expect(tools).toHaveLength(14)
  })
})

describe('开场入口 page_open（没有页面时 agent 的起点）', () => {
  it('把 url 交给 host 打开，并把新页面当作当前页', async () => {
    const host = fakeHost()
    const result = await toolNamed(`${TOOL_PREFIX}page_open`, host).run({
      url: 'https://www.humblebundle.com/home/keys',
    })
    expect(host.browserOpenPage).toHaveBeenCalledWith('https://www.humblebundle.com/home/keys')
    expect(result).toMatchObject({ pageId: 2, selected: true })
  })

  it('工具清单里有它（否则空台账时无从下手）', () => {
    expect(createTools(fakeHost()).map((t) => t.name)).toContain(`${TOOL_PREFIX}page_open`)
  })
})

describe('页面读取落库 keys_ingest（ADR-0003 的唯一落库入口）', () => {
  it('把页面读到的东西原样交给 host，不替 agent 编数据', async () => {
    const host = fakeHost()
    const read = {
      orderGamekey: 'TXzbXSpBc3qfUc3M',
      productName: 'Best of Leartes',
      keys: [
        { name: 'Astronauts (Pack)', revealed: true, code: 'AAAA-BBBB' },
        { name: 'Creatures (Pack)', revealed: false },
      ],
    }
    await toolNamed(`${TOOL_PREFIX}keys_ingest`, host).run(read)
    expect(host.keysIngest).toHaveBeenCalledWith(read)
  })

  it('工具清单里有它（否则页面读到的东西无处落库）', () => {
    expect(createTools(fakeHost()).map((t) => t.name)).toContain(`${TOOL_PREFIX}keys_ingest`)
  })
})

describe('keys_ingest 的 schema：平台由 agent 逐行判断，取值只做收敛', () => {
  function keysSchema() {
    const spec = createTools(fakeHost()).find((tool) => tool.name === `${TOOL_PREFIX}keys_ingest`)
    const parameters = spec?.parameters as unknown as {
      properties: {
        keys: {
          items: {
            required?: string[]
            properties?: Record<string, { description?: string; minLength?: number }>
          }
        }
      }
    }
    return parameters.properties.keys.items
  }

  it('每条 key 的 redemptionUrl 是 required，但**不要求非空**', () => {
    const keys = keysSchema()
    expect(keys.required).toContain('redemptionUrl')
    // 实测 schema 报错会让整笔写入回滚 —— 一行空串 → 整单丢失。
    expect(keys.properties?.redemptionUrl?.minLength).toBeUndefined()
  })

  it('每条 key 的 platform 是 required（防漏传），但不做非空 / 枚举约束', () => {
    const keys = keysSchema()
    expect(Object.keys(keys.properties ?? {})).toContain('platform')
    // 「必填」是为了防 agent 漏传（漏了就等于根本没判断）；而 `unknown` 是合法答案，「判不出」不算漏传。
    expect(keys.required ?? []).toContain('platform')
    // 自由字符串，不做非空 / 枚举约束（枚举会让「判不出」的写法在 schema 层直接失败）。
    expect(keys.properties?.platform?.minLength).toBeUndefined()
    expect(keys.properties?.platform).not.toHaveProperty('anyOf')
  })

  it('platform 的描述写清取值范围、「逐行判断」与「不许编」', () => {
    const description = keysSchema().properties?.platform?.description ?? ''
    for (const name of ['fab', 'epic', 'steam', 'unity', 'gog', 'unknown']) {
      expect(description).toContain(name)
    }
    expect(description).toContain('逐行判断')
    expect(description).toContain('不要编')
    // 旧说法（平台由应用解析）必须消失。
    expect(description).not.toContain('平台由应用解析')
  })

  it('每条 key 含 noCodeReason，且**不是必填**（有码的行不用给）', () => {
    const keys = keysSchema()
    expect(Object.keys(keys.properties ?? {})).toContain('noCodeReason')
    expect(keys.required ?? []).not.toContain('noCodeReason')
    // 自由字符串，不做非空 / 枚举约束（枚举会让「判不出」的写法在 schema 层失败、拖垮整单）。
    expect(keys.properties?.noCodeReason?.minLength).toBeUndefined()
    expect(keys.properties?.noCodeReason).not.toHaveProperty('anyOf')
  })

  it('noCodeReason 的描述写清取值范围与「有码不用给 / 判不出写 unknown / 不要编」', () => {
    const description = keysSchema().properties?.noCodeReason?.description ?? ''
    for (const name of ['expired', 'exhausted', 'link_only', 'unknown']) {
      expect(description).toContain(name)
    }
    expect(description).toContain('有码')
    expect(description).toContain('不要编')
  })
})

describe('keys_upsert 的无码缘由（可选 + 收敛后转发）', () => {
  function entriesSchema() {
    const spec = createTools(fakeHost()).find((tool) => tool.name === `${TOOL_PREFIX}keys_upsert`)
    const parameters = spec?.parameters as unknown as {
      properties: {
        entries: {
          items: {
            required?: string[]
            properties?: Record<string, { description?: string; minLength?: number }>
          }
        }
      }
    }
    return parameters.properties.entries.items
  }

  it('entries 每条含 noCodeReason，且不是必填', () => {
    const entry = entriesSchema()
    expect(Object.keys(entry.properties ?? {})).toContain('noCodeReason')
    expect(entry.required ?? []).not.toContain('noCodeReason')
  })

  it('noCodeReason 的描述写清取值范围与「有码不用给」', () => {
    const description = entriesSchema().properties?.noCodeReason?.description ?? ''
    for (const name of ['expired', 'exhausted', 'link_only', 'unknown']) {
      expect(description).toContain(name)
    }
    expect(description).toContain('有码')
    expect(description).toContain('不要编')
  })

  it('handler 把 noCodeReason 收敛后转发给宿主（大小写 / 非法值都归一）', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}keys_upsert`, host).run({
      entries: [
        { keyId: 1, code: 'X', revealed: true },
        { keyId: 2, noCodeReason: '  EXPIRED ' },
        { keyId: 3, noCodeReason: 'bogus' },
      ],
    })
    expect(host.keysUpsert).toHaveBeenCalledWith([
      { keyId: 1, code: 'X', revealed: true },
      { keyId: 2, noCodeReason: 'expired' },
      { keyId: 3, noCodeReason: 'unknown' },
    ])
  })
})

/**
 * 覆盖率审计（`job_mujasg38_8`，只读）指出这四个工具的 **handler 从未被执行过**：
 * 测试只断言了它们的层级与 schema 形状，没跑过 `run`。这里补上行为断言。
 */
describe('工具行为：审计点名未被执行过的 handler', () => {
  it('ledger_stats 原样转发宿主的统计结果（不多不少）', async () => {
    const host = fakeHost()
    const result = await toolNamed(`${TOOL_PREFIX}ledger_stats`, host).run({})
    expect(host.ledgerStats).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      total: 10,
      unrevealed: 3,
      revealedUnredeemed: 6,
      redeemed: 1,
    })
  })

  it('orders_sync 原样转发宿主的同步结果', async () => {
    const host = fakeHost({ ordersSync: vi.fn(async () => ({ orders: { inserted: 2 } })) })
    const result = await toolNamed(`${TOOL_PREFIX}orders_sync`, host).run({})
    expect(host.ordersSync).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ orders: { inserted: 2 } })
  })

  it('screenshot 有内联图数据时返回**图片内容块**，不塞进 JSON', async () => {
    const host = fakeHost({
      browserTakeScreenshot: vi.fn(async () => ({
        pageId: 1,
        format: 'jpeg',
        bytes: 3,
        data: 'QUJD',
      })),
    })
    const result = await toolNamed(`${TOOL_PREFIX}screenshot`, host).run({ format: 'jpeg' })
    expect(result).toEqual({
      content: [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }],
    })
    // 参数要透传（uid/fullPage/quality/filePath 都是 agent 会用的）。
    expect(host.browserTakeScreenshot).toHaveBeenCalledWith({
      uid: undefined,
      fullPage: undefined,
      format: 'jpeg',
      quality: undefined,
      filePath: undefined,
    })
  })

  it('screenshot 存成文件（没有内联数据）时原样返回路径与字节数', async () => {
    const host = fakeHost({
      browserTakeScreenshot: vi.fn(async () => ({
        pageId: 1,
        format: 'png',
        bytes: 11,
        path: '/tmp/shot.png',
      })),
    })
    const result = await toolNamed(`${TOOL_PREFIX}screenshot`, host).run({
      filePath: '/tmp/shot.png',
    })
    expect(result).toEqual({ pageId: 1, format: 'png', bytes: 11, path: '/tmp/shot.png' })
  })

  it('errors 转发过滤条件并原样返回宿主给的错误清单', async () => {
    const host = fakeHost()
    const result = await toolNamed(`${TOOL_PREFIX}errors`, host).run({
      types: ['error'],
      includeStackTraces: true,
      limit: 5,
    })
    // 三个可选参数都要透传（agent 靠它们收窄噪声）。
    expect(host.browserErrors).toHaveBeenCalledWith({
      types: ['error'],
      includeStackTraces: true,
      limit: 5,
    })
    // 原样返回，不重新包装（宿主给的结构就是给 agent 看的）。
    expect(result).toEqual({ pageId: 1, url: 'u', errors: [], failedRequests: [] })
  })
})
