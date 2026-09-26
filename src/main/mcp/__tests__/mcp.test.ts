import { describe, expect, it, vi } from 'vitest'
import { extractToken, tokenMatches } from '../server'
import { createMcpTools, type McpHost, TOOL_PREFIX } from '../tools'

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
    // —— 浏览器镜像（Chrome MCP 对齐）——
    browserListPages: vi.fn(async () => [{ pageId: 1, url: 'u', title: 't', selected: true }]),
    browserSelectPage: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', selected: true })),
    browserNewPage: vi.fn(async () => ({ pageId: 2, url: 'u2', title: 't2', selected: true })),
    browserClosePage: vi.fn(async () => ({ closed: 2, pages: [] })),
    browserNavigatePage: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', selected: true })),
    browserWaitFor: vi.fn(async () => ({ matched: 'x' })),
    browserEmulate: vi.fn(async () => ({ pageId: 1, applied: [] })),
    browserResizePage: vi.fn(async () => ({ pageId: 1, width: 800, height: 600 })),
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
    browserClickAt: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserHover: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserDrag: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserFill: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserFillForm: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserTypeText: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserPressKey: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserUploadFile: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserHandleDialog: vi.fn(async () => ({ pageId: 1, url: 'u', title: 't', detail: 'ok' })),
    browserEvaluateScript: vi.fn(async () => ({ value: 1 })),
    browserListConsoleMessages: vi.fn(async () => ({ messages: [], total: 0 })),
    browserGetConsoleMessage: vi.fn(async () => ({ msgid: 1, type: 'log', text: 'x' })),
    browserListNetworkRequests: vi.fn(async () => ({ requests: [], total: 0 })),
    browserGetNetworkRequest: vi.fn(async () => ({ reqid: 1, url: 'u', method: 'GET' })),
    browserGetCssStyles: vi.fn(async () => ({ rules: [], total: 0, pageIdx: 0 })),
    browserPerformanceStartTrace: vi.fn(async () => ({ pageId: 1 })),
    browserPerformanceStopTrace: vi.fn(async () => ({ pageId: 1, path: '/tmp/t.json' })),
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
      `${TOOL_PREFIX}click`,
      `${TOOL_PREFIX}take_snapshot`,
      `${TOOL_PREFIX}navigate_page`,
      `${TOOL_PREFIX}evaluate_script`,
      `${TOOL_PREFIX}take_screenshot`,
    ]
    // 浏览器类工具是 Chrome MCP 的镜像，数量明显多于领域工具。
    expect(
      tools.filter((tool) => tool.description.includes('MonoSpace 应用内置的浏览会话')).length,
    ).toBeGreaterThan(20)
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
    expect(layerOf(`${TOOL_PREFIX}take_snapshot`)).toBe('L0')
    expect(layerOf(`${TOOL_PREFIX}list_console_messages`)).toBe('L0')
    expect(layerOf(`${TOOL_PREFIX}orders_sync`)).toBe('L1')
    expect(layerOf(`${TOOL_PREFIX}keys_upsert`)).toBe('L1')
    expect(layerOf(`${TOOL_PREFIX}click`)).toBe('L1')
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

  it('click 转发 pageId 与 uid（用最近快照的引用）', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}click`, host).run({ pageId: 3, uid: '1_5', dblClick: true })
    expect(host.browserClick).toHaveBeenCalledWith(3, '1_5', {
      dblClick: true,
      includeSnapshot: undefined,
    })
  })

  it('take_snapshot 转发 pageId 与 verbose', async () => {
    const host = fakeHost()
    const result = await toolNamed(`${TOOL_PREFIX}take_snapshot`, host).run({
      pageId: 4,
      verbose: true,
    })
    expect(host.browserTakeSnapshot).toHaveBeenCalledWith(4, {
      filePath: undefined,
      verbose: true,
    })
    expect(result).toMatchObject({ nodeCount: 1 })
  })

  it('evaluate_script 转发函数与参数', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}evaluate_script`, host).run({
      pageId: 2,
      function: '() => document.title',
      args: [1, 'a'],
    })
    expect(host.browserEvaluateScript).toHaveBeenCalledWith(2, '() => document.title', {
      args: [1, 'a'],
      dialogAction: undefined,
      filePath: undefined,
      waitForStableDom: undefined,
    })
  })

  it('navigate_page 转发导航参数', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}navigate_page`, host).run({
      pageId: 1,
      type: 'url',
      url: 'https://example.com',
    })
    expect(host.browserNavigatePage).toHaveBeenCalledWith(1, {
      type: 'url',
      url: 'https://example.com',
      timeout: undefined,
      ignoreCache: undefined,
      handleBeforeUnload: undefined,
    })
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
