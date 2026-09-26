import { describe, expect, it, vi } from 'vitest'
import { extractToken, tokenMatches } from '../server'
import { createMcpTools, type McpHost, MONOSPACE_TAG, TOOL_PREFIX } from '../tools'

function fakeHost(overrides: Partial<McpHost> = {}): McpHost {
  return {
    ledgerStats: vi.fn(async () => ({
      total: 10,
      unrevealed: 3,
      revealedUnredeemed: 6,
      redeemed: 1,
      byEngine: { unity: 4, unreal: 5, unknown: 1 },
    })),
    ledgerQuery: vi.fn(async () => [
      {
        keyId: 1,
        name: '素材',
        bundle: 'Synty',
        order: '某单',
        engine: 'unity',
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
            engine: 'unity',
            revealStatus: 'unrevealed',
            redeemStatus: 'not_redeemed',
            redeemCode: 'SECRET-CODE',
          }
        : null,
    ),
    // —— 浏览器（融合缩减后的 5 个工具背后）——
    browserCurrentPage: vi.fn(async () => ({
      pageId: 1,
      url: 'u',
      title: 't',
      selected: true,
    })),
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
    keysUpsert: vi.fn(async () => ({ written: 1, auditId: 'a#1' })),
    keyReveal: vi.fn(async () => ({ status: 'revealed', attempts: 1, note: 'ok' })),
    keyRedeem: vi.fn(async () => ({ status: 'redeemed', attempts: 1, note: 'ok' })),
    ...overrides,
  }
}

function toolNamed(name: string, host: McpHost = fakeHost()) {
  const tool = createMcpTools(host).find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`没有工具 ${name}`)
  return tool
}

describe('命名：全部 monospace_ 前缀（防与其它浏览器 MCP 撞名）', () => {
  it('所有工具都带前缀', () => {
    for (const tool of createMcpTools(fakeHost())) {
      expect(tool.name.startsWith(TOOL_PREFIX)).toBe(true)
    }
  })

  it('浏览器类工具都声明了作用范围（与其它浏览器 MCP 区分）', () => {
    const tools = createMcpTools(fakeHost())
    // 与内置浏览器语义相关的工具（key_page_read 也会驱动内置浏览器，但不带 browser 段）。
    const browserSemantic = [
      `${TOOL_PREFIX}dom`,
      `${TOOL_PREFIX}screenshot`,
      `${TOOL_PREFIX}script`,
      `${TOOL_PREFIX}act`,
      `${TOOL_PREFIX}errors`,
    ]
    // 融合缩减：浏览器接口就这 5 个（其余能力收进 act）。
    expect(
      tools.filter((tool) => tool.description.includes('MonoSpace 应用内置的浏览会话')).length,
    ).toBe(5)
    for (const name of browserSemantic) {
      const tool = tools.find((candidate) => candidate.name === name)
      expect(tool, name).toBeDefined()
      expect(tool?.description).toContain('MonoSpace 应用内置的浏览会话')
      expect(tool?.description).toContain('不是系统 Chrome')
    }
  })

  it('没有裸名工具（如 goto/snapshot/click）', () => {
    const names = createMcpTools(fakeHost()).map((tool) => tool.name)
    for (const bare of ['goto', 'snapshot', 'click', 'navigate', 'screenshot']) {
      expect(names).not.toContain(bare)
    }
  })
})

describe('权限分层（#13）', () => {
  it('只读 / 写入 / 不可逆三层各自归位', () => {
    const tools = createMcpTools(fakeHost())
    const layerOf = (name: string) => tools.find((t) => t.name === name)?.layer
    expect(layerOf(`${TOOL_PREFIX}ledger_stats`)).toBe('L0')
    expect(layerOf(`${TOOL_PREFIX}dom`)).toBe('L0')
    expect(layerOf(`${TOOL_PREFIX}errors`)).toBe('L0')
    expect(layerOf(`${TOOL_PREFIX}orders_sync`)).toBe('L1')
    expect(layerOf(`${TOOL_PREFIX}keys_upsert`)).toBe('L1')
    expect(layerOf(`${TOOL_PREFIX}act`)).toBe('L1')
    expect(layerOf(`${TOOL_PREFIX}key_reveal`)).toBe('L2')
    expect(layerOf(`${TOOL_PREFIX}key_redeem`)).toBe('L2')
  })
})

describe('工具行为', () => {
  it('ledger_query 转发查询参数', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}ledger_query`, host).run({ view: 'unrevealed', limit: 10 })
    expect(host.ledgerQuery).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'unrevealed', limit: 10 }),
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

  it('act(click) 作用于当前页面并转发 uid', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}act`, host).run({ action: 'click', uid: '1_5' })
    expect(host.browserCurrentPage).toHaveBeenCalled()
    expect(host.browserClick).toHaveBeenCalledWith(1, '1_5', { includeSnapshot: undefined })
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
    expect(host.browserTakeSnapshot).toHaveBeenCalledWith(1, {
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
    expect(host.browserEvaluateScript).toHaveBeenCalledWith(1, '() => document.title', {
      args: [1, 'a'],
      filePath: undefined,
      waitForStableDom: undefined,
    })
  })

  it('act(goto) 转发 url', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}act`, host).run({ action: 'goto', url: 'https://example.com' })
    expect(host.browserNavigatePage).toHaveBeenCalledWith(1, {
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
    expect(host.browserScroll).toHaveBeenCalledWith(1, 'up', 300)
  })

  it('keys_upsert 转发条目', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}keys_upsert`, host).run({
      entries: [{ keyId: 1, code: 'X', revealed: true }],
    })
    expect(host.keysUpsert).toHaveBeenCalledWith([{ keyId: 1, code: 'X', revealed: true }])
  })

  it('不可逆工具转发到既有链路', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}key_reveal`, host).run({ keyId: 3 })
    await toolNamed(`${TOOL_PREFIX}key_redeem`, host).run({ keyId: 3 })
    expect(host.keyReveal).toHaveBeenCalledWith(3)
    expect(host.keyRedeem).toHaveBeenCalledWith(3)
  })
})

describe('token 校验（本地服务的唯一门禁）', () => {
  it('常量时间比较：正确通过、错误/缺失拒绝', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true)
    expect(tokenMatches('abc123', 'abc124')).toBe(false)
    expect(tokenMatches('abc123', 'abc12')).toBe(false)
    expect(tokenMatches('abc123', null)).toBe(false)
    expect(tokenMatches('abc123', '')).toBe(false)
  })

  it('从 query 或 Authorization 头取 token', () => {
    expect(extractToken('/mcp?token=xyz')).toBe('xyz')
    expect(extractToken('/mcp', 'Bearer xyz')).toBe('xyz')
    expect(extractToken('/mcp')).toBeNull()
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

describe('工具返回形态', () => {
  it('截图类工具自己给 content 块时不被 JSON 包裹（否则图片会变成文本）', async () => {
    const { isToolContent } = await import('../server')
    expect(isToolContent({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] })).toBe(
      true,
    )
    expect(isToolContent({ nodeCount: 1 })).toBe(false)
    expect(isToolContent(null)).toBe(false)
  })

  it('screenshot 内联时回图片块，落盘时回路径', async () => {
    const host = fakeHost({
      browserTakeScreenshot: vi.fn(async () => ({
        pageId: 1,
        format: 'png',
        bytes: 3,
        data: 'AAAA',
      })),
    })
    const inline = (await toolNamed(`${TOOL_PREFIX}screenshot`, host).run({})) as {
      content: Array<{ type: string }>
    }
    expect(inline.content[0]?.type).toBe('image')

    const saved = fakeHost({
      browserTakeScreenshot: vi.fn(async () => ({
        pageId: 1,
        format: 'png',
        bytes: 3,
        path: '/tmp/a.png',
      })),
    })
    const onDisk = await toolNamed(`${TOOL_PREFIX}screenshot`, saved).run({
      filePath: '/tmp/a.png',
    })
    expect(onDisk).toMatchObject({ path: '/tmp/a.png' })
  })
})

describe('与真实浏览器 MCP 区分（用户要求强调）', () => {
  it('每一个工具的描述都以【MonoSpace】开头', () => {
    for (const spec of createMcpTools(fakeHost())) {
      expect(spec.description.startsWith(MONOSPACE_TAG), spec.name).toBe(true)
    }
  })

  it('浏览器类工具点名了最容易混淆的对手', () => {
    const dom = createMcpTools(fakeHost()).find((t) => t.name === `${TOOL_PREFIX}dom`)
    expect(dom?.description).toContain('Chrome DevTools MCP')
    expect(dom?.description).toContain('Playwright')
    expect(dom?.description).toContain('不是系统 Chrome')
  })

  it('作用域声明里的名字与真实浏览器 MCP 不同（避免同名同义误用）', () => {
    // Chrome DevTools MCP 用的是 click / take_snapshot / navigate_page；
    // 我们的是 act / dom / act(goto)——同义不同名，前缀也不同。
    const names = createMcpTools(fakeHost()).map((t) => t.name)
    expect(names).not.toContain('take_snapshot')
    expect(names).not.toContain('navigate_page')
    expect(names).toContain(`${TOOL_PREFIX}dom`)
  })
})

describe('工具表完整性', () => {
  it('工具名唯一（重名会让客户端只认到一个，等于悄悄少功能）', () => {
    const names = createMcpTools(fakeHost()).map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('浏览器接口就 5 个，领域接口 7 个', () => {
    const tools = createMcpTools(fakeHost())
    const browser = tools.filter((tool) => tool.description.includes('不是系统 Chrome'))
    expect(browser).toHaveLength(5)
    expect(tools).toHaveLength(12)
  })
})
