/**
 * 适配器测试（见 `#31` 反向决策：工具表是唯一事实来源，MCP 关掉、改为注入内置 Pi）。
 *
 * 重点测三件真会出错的事：L2 有没有被挡住、截图块有没有被重复包一层 JSON、工具抛错有没有被吞掉。
 */
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'
import { adaptTools, isToolContent, toPiTool, toToolResult } from '../tool-adapter'
import type { ToolSpec } from '../tools'

/** SDK 的 execute 要 5 个参数（第 5 个是扩展上下文）；测试只关心前两个。 */
function call(tool: ReturnType<typeof toPiTool>, input: Record<string, unknown>) {
  return tool.execute('call-test', input, undefined, undefined, undefined as never)
}

function spec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name: 'monospace_demo',
    title: '示例',
    description: '【MonoSpace】示例工具',
    layer: 'L0',
    parameters: Type.Object({}),
    run: async () => ({ hello: 'world' }),
    ...overrides,
  }
}

describe('adaptTools', () => {
  it('把工具表映射成 Pi 形状（name/label/description/parameters）', () => {
    const [tool] = adaptTools([spec()])
    expect(tool.name).toBe('monospace_demo')
    // Pi 要的是 label，工具表里叫 title —— 这里必须换名，否则 UI 上没标题。
    expect(tool.label).toBe('示例')
    expect(tool.description).toBe('【MonoSpace】示例工具')
    expect(tool.parameters).toMatchObject({ type: 'object' })
  })

  it('默认挡住 L2（揭示/兑换不可逆，不给模型）', () => {
    const tools = adaptTools([
      spec({ name: 'monospace_a', layer: 'L0' }),
      spec({ name: 'monospace_b', layer: 'L1' }),
      spec({ name: 'monospace_key_reveal', layer: 'L2' }),
      spec({ name: 'monospace_key_redeem', layer: 'L2' }),
    ])
    expect(tools.map((t) => t.name)).toEqual(['monospace_a', 'monospace_b'])
  })

  it('显式清空 deny 列表时 L2 才放行', () => {
    const tools = adaptTools([spec({ name: 'monospace_key_reveal', layer: 'L2' })], {
      deniedLayers: [],
    })
    expect(tools.map((t) => t.name)).toEqual(['monospace_key_reveal'])
  })
})

describe('isToolContent', () => {
  it('认得 text 块与 image 块', () => {
    expect(isToolContent({ content: [{ type: 'text', text: 'hi' }] })).toBe(true)
    expect(isToolContent({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] })).toBe(
      true,
    )
  })

  it('普通结构化数据不算 content 块', () => {
    expect(isToolContent({ nodeCount: 1 })).toBe(false)
    expect(isToolContent({ content: [] })).toBe(false)
    expect(isToolContent({ content: [{ type: 'json' }] })).toBe(false)
    expect(isToolContent(null)).toBe(false)
    expect(isToolContent('text')).toBe(false)
  })
})

describe('toToolResult', () => {
  it('字符串直接成文本', () => {
    expect(toToolResult('好的')).toMatchObject({ content: [{ type: 'text', text: '好的' }] })
  })

  it('结构化数据序列化成 JSON 文本（模型读不了 [object Object]）', () => {
    const result = toToolResult({ nodeCount: 1 })
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ nodeCount: 1 })
  })

  it('截图这类 content 块原样透传，不重复包一层 JSON', () => {
    const blocks = [{ type: 'image', data: 'x', mimeType: 'image/png' }]
    const result = toToolResult({ content: blocks })
    expect(result.content).toBe(blocks)
  })
})

describe('toPiTool.execute', () => {
  it('工具抛错时**原样抛出**（SDK 约定：不要把错误编码进 content）', async () => {
    const tool = toPiTool(
      spec({
        run: async () => {
          throw new Error('页面没打开')
        },
      }),
    )
    await expect(call(tool, {})).rejects.toThrow('页面没打开')
  })

  it('正常返回被包成文本结果', async () => {
    const tool = toPiTool(spec({ run: async (input) => ({ got: input.foo }) }))
    const result = await call(tool, { foo: 'bar' })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ got: 'bar' })
  })
})
