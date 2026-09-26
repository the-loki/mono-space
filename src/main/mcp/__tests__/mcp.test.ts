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
    browserStatus: vi.fn(async () => ({ url: 'u', title: 't', status: 200 })),
    browserGoto: vi.fn(async () => ({ url: 'u', title: 't', status: 200 })),
    browserSnapshot: vi.fn(async () => ({
      url: 'u',
      title: 't',
      text: '- RootWebArea "x"',
      nodeCount: 1,
      truncated: false,
    })),
    browserScreenshot: vi.fn(async () => ({ path: '/tmp/a.png' })),
    keyPageRead: vi.fn(async () => ({
      url: 'u#k',
      snapshot: { url: 'u#k', title: 't', text: 'x', nodeCount: 1, truncated: false },
    })),
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
      `${TOOL_PREFIX}browser_status`,
      `${TOOL_PREFIX}browser_goto`,
      `${TOOL_PREFIX}browser_snapshot`,
      `${TOOL_PREFIX}browser_screenshot`,
      `${TOOL_PREFIX}key_page_read`,
    ]
    expect(tools.filter((tool) => tool.name.includes('browser_'))).toHaveLength(4)
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
    expect(layerOf(`${TOOL_PREFIX}browser_snapshot`)).toBe('L0')
    expect(layerOf(`${TOOL_PREFIX}key_page_read`)).toBe('L0')
    expect(layerOf(`${TOOL_PREFIX}orders_sync`)).toBe('L1')
    expect(layerOf(`${TOOL_PREFIX}keys_upsert`)).toBe('L1')
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

  it('key_page_read 转发 keyId', async () => {
    const host = fakeHost()
    await toolNamed(`${TOOL_PREFIX}key_page_read`, host).run({ keyId: 7 })
    expect(host.keyPageRead).toHaveBeenCalledWith(7)
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
