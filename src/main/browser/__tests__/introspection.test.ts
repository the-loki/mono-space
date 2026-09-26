import { describe, expect, it } from 'vitest'
import {
  type CssRule,
  contentSizeClip,
  decodeResponseBody,
  elementClipFromBoxModel,
  filenameFromUrl,
  filterConsoleMessages,
  filterNetworkRequests,
  flattenPreservedHistory,
  formatConsoleArgs,
  formatCssAncestors,
  formatCssSource,
  formatStackTrace,
  groupConsecutiveConsoleMessages,
  limitBodyText,
  markOverloadedDeclarations,
  mergeHeaders,
  normalizeConsoleType,
  orderCssRules,
  paginate,
  pushPreservedHistory,
  resolveScreenshotQuality,
  toCssDeclarations,
  viewportOffset,
} from '../introspection'

describe('控制台：类型归一与渲染', () => {
  it('console.warn 归一到 warning，其余原样', () => {
    expect(normalizeConsoleType('warn')).toBe('warning')
    expect(normalizeConsoleType('warning')).toBe('warning')
    expect(normalizeConsoleType('log')).toBe('log')
    expect(normalizeConsoleType('assert')).toBe('assert')
  })

  it('多个参数按 Chrome MCP 的 join(" ") 渲染', () => {
    const text = formatConsoleArgs([
      { value: 'hello' },
      { value: 42 },
      { value: { a: 1 } },
      { unserializableValue: '5n' },
      { type: 'undefined' },
    ])
    expect(text).toBe('hello 42 {"a":1} 5n undefined')
  })

  it('对象没有 value 时退回 description', () => {
    expect(formatConsoleArgs([{ type: 'object', description: 'Array(3)' }])).toBe('Array(3)')
  })

  it('空参数渲染为空串（assert/异常消息常见）', () => {
    expect(formatConsoleArgs(undefined)).toBe('')
    expect(formatConsoleArgs([])).toBe('')
  })

  it('栈帧渲染为 at name (url:line:col)，行列号 1-based', () => {
    const text = formatStackTrace({
      callFrames: [
        {
          functionName: 'reveal',
          url: 'https://humble.test/x.js',
          lineNumber: 11,
          columnNumber: 4,
        },
      ],
    })
    expect(text).toBe('at reveal (https://humble.test/x.js:12:5)')
  })

  it('无 url 的帧只写函数名；空栈返回 undefined', () => {
    expect(formatStackTrace({ callFrames: [{ functionName: '' }] })).toBe('at <anonymous>')
    expect(formatStackTrace(undefined)).toBeUndefined()
    expect(formatStackTrace({ callFrames: [] })).toBeUndefined()
  })

  it('超过 50 帧折叠成一行计数', () => {
    const frames = Array.from({ length: 55 }, (_, index) => ({
      functionName: `f${index}`,
      url: 'https://x/y.js',
      lineNumber: index,
      columnNumber: 0,
    }))
    const text = formatStackTrace({ callFrames: frames }) ?? ''
    expect(text.split('\n')).toHaveLength(51)
    expect(text).toContain('... and 5 more frames')
  })
})

describe('控制台：过滤与连续合并', () => {
  const messages = [
    { msgid: 1, type: 'warning', text: 'a' },
    { msgid: 2, type: 'error', text: 'b' },
    { msgid: 3, type: 'warning', text: 'c' },
  ]

  it('types 为空返回全部', () => {
    expect(filterConsoleMessages(messages, undefined)).toHaveLength(3)
    expect(filterConsoleMessages(messages, [])).toHaveLength(3)
  })

  it('过滤值也走归一（warn 命中 warning）', () => {
    const filtered = filterConsoleMessages(messages, ['warn'])
    expect(filtered.map((message) => message.msgid)).toEqual([1, 3])
  })

  it('只合并相邻的同类型同文本，并累加 count', () => {
    const grouped = groupConsecutiveConsoleMessages([
      { msgid: 1, type: 'log', text: 'tick' },
      { msgid: 2, type: 'log', text: 'tick' },
      { msgid: 3, type: 'log', text: 'other' },
      { msgid: 4, type: 'log', text: 'tick' },
    ])
    expect(grouped.map((message) => [message.msgid, message.count ?? 1])).toEqual([
      [1, 2],
      [3, 1],
      [4, 1],
    ])
  })
})

describe('保留历史：导航裁剪策略', () => {
  it('导航把当前批次压到最前', () => {
    expect(pushPreservedHistory([], [1, 2])).toEqual([[1, 2]])
  })

  it('最多保留 3 段，最老的被挤掉', () => {
    const preserved = pushPreservedHistory([[1], [2], [3]], [4])
    expect(preserved).toEqual([[4], [1], [2]])
  })

  it('展开顺序是 最老 → 当前（对齐 Chrome MCP）', () => {
    expect(flattenPreservedHistory([[3], [2], [1]], [4])).toEqual([1, 2, 3, 4])
    expect(flattenPreservedHistory([], [9])).toEqual([9])
  })
})

describe('分页切片', () => {
  const items = [0, 1, 2, 3, 4]

  it('不给分页参数时返回全部', () => {
    const result = paginate(items)
    expect(result.items).toEqual(items)
    expect(result.totalPages).toBe(1)
    expect(result.invalidPage).toBe(false)
  })

  it('只给 pageSize 时默认第 0 页', () => {
    const result = paginate(items, { pageSize: 2 })
    expect(result.items).toEqual([0, 1])
    expect(result.totalPages).toBe(3)
    expect(result.pageIdx).toBe(0)
  })

  it('pageIdx 正常切片', () => {
    const result = paginate(items, { pageIdx: 2, pageSize: 2 })
    expect(result.items).toEqual([4])
    expect(result.pageIdx).toBe(2)
  })

  it('越界 pageIdx 回落到第 0 页并标记 invalidPage', () => {
    const result = paginate(items, { pageIdx: 99, pageSize: 2 })
    expect(result.items).toEqual([0, 1])
    expect(result.pageIdx).toBe(0)
    expect(result.invalidPage).toBe(true)
  })

  it('空数组也能分页，totalPages 至少为 1', () => {
    const result = paginate([], { pageIdx: 0, pageSize: 10 })
    expect(result.items).toEqual([])
    expect(result.totalPages).toBe(1)
  })
})

describe('网络：头合并、过滤与正文', () => {
  it('extraInfo 头覆盖基础头（Cookie/Set-Cookie 靠它）', () => {
    expect(mergeHeaders({ cookie: 'a' }, { cookie: 'b', 'set-cookie': 'c' })).toEqual({
      cookie: 'b',
      'set-cookie': 'c',
    })
    expect(mergeHeaders(undefined, undefined)).toBeUndefined()
  })

  it('按资源类型过滤', () => {
    const requests = [
      { reqid: 1, url: 'a', method: 'GET', resourceType: 'document' },
      { reqid: 2, url: 'b', method: 'GET', resourceType: 'xhr' },
    ]
    expect(filterNetworkRequests(requests, ['xhr']).map((request) => request.reqid)).toEqual([2])
    expect(filterNetworkRequests(requests, undefined)).toHaveLength(2)
  })

  it('内联正文按上限截断', () => {
    expect(limitBodyText('abcdef', 3)).toBe('abc... <truncated>')
    expect(limitBodyText('abc', 3)).toBe('abc')
  })

  it('响应体解码：UTF-8 原样、空与二进制有专门说明', () => {
    expect(decodeResponseBody('中文', false)).toBe('中文')
    expect(decodeResponseBody(Buffer.from('中文').toString('base64'), true)).toBe('中文')
    expect(decodeResponseBody('', false)).toBe('<empty response>')
    expect(decodeResponseBody(Buffer.from([0x80, 0xff]).toString('base64'), true)).toBe(
      '<binary data>',
    )
  })
})

describe('CSS：声明归一与 overloaded 标记', () => {
  it('!important 从值里剥离并单独标记', () => {
    expect(
      toCssDeclarations([{ name: 'color', value: 'red !important', important: true }]),
    ).toEqual([{ property: 'color', value: 'red', important: true }])
    expect(toCssDeclarations([{ name: 'color', value: 'blue' }])).toEqual([
      { property: 'color', value: 'blue' },
    ])
  })

  const rule = (selector: string, declarations: CssRule['declarations']): CssRule => ({
    selector,
    origin: 'regular',
    declarations,
  })

  it('高优先级声明生效，低优先级同名声明标 overloaded', () => {
    const marked = markOverloadedDeclarations([
      rule('element.style', [{ property: 'color', value: 'red' }]),
      rule('.a', [{ property: 'color', value: 'blue' }]),
    ])
    expect(marked[0].declarations[0].overloaded).toBeUndefined()
    expect(marked[1].declarations[0].overloaded).toBe(true)
  })

  it('!important 压过更靠前的非 important 声明', () => {
    const marked = markOverloadedDeclarations([
      rule('element.style', [{ property: 'color', value: 'red' }]),
      rule('.a', [{ property: 'color', value: 'blue', important: true }]),
    ])
    expect(marked[0].declarations[0].overloaded).toBe(true)
    expect(marked[1].declarations[0].overloaded).toBeUndefined()
  })

  it('同一规则内后写的声明胜出', () => {
    const marked = markOverloadedDeclarations([
      rule('.a', [
        { property: 'color', value: 'red' },
        { property: 'color', value: 'blue' },
      ]),
    ])
    expect(marked[0].declarations[0].overloaded).toBe(true)
    expect(marked[0].declarations[1].overloaded).toBeUndefined()
  })

  it('不同属性互不影响', () => {
    const marked = markOverloadedDeclarations([
      rule('element.style', [
        { property: 'color', value: 'red' },
        { property: 'display', value: 'flex' },
      ]),
    ])
    expect(marked[0].declarations.every((declaration) => !declaration.overloaded)).toBe(true)
  })
})

describe('CSS：规则排序与来源定位', () => {
  it('按 inline → matched → attributes → property → pseudo → inherited 排序', () => {
    const make = (
      kind: 'inherited' | 'matched' | 'inline' | 'attributes' | 'property' | 'pseudo',
      order: number,
    ) => ({
      kind,
      order,
      rule: { selector: kind, origin: 'regular', declarations: [] } as CssRule,
    })
    const ordered = orderCssRules([
      make('inherited', 5),
      make('pseudo', 4),
      make('property', 3),
      make('attributes', 2),
      make('matched', 1),
      make('inline', 0),
    ])
    expect(ordered.map((rule) => rule.selector)).toEqual([
      'inline',
      'matched',
      'attributes',
      'property',
      'pseudo',
      'inherited',
    ])
  })

  it('overloaded 只作用于元素自身层叠（不碰 inherited）', () => {
    const collected = [
      {
        kind: 'matched' as const,
        order: 0,
        rule: {
          selector: '.a',
          origin: 'regular',
          declarations: [{ property: 'color', value: 'red' }],
        },
      },
      {
        kind: 'inherited' as const,
        order: 1,
        rule: {
          selector: '.parent',
          origin: 'regular',
          declarations: [{ property: 'color', value: 'green' }],
        },
      },
    ]
    const ordered = orderCssRules(collected)
    expect(ordered[0].declarations[0].overloaded).toBeUndefined()
    expect(ordered[1].declarations[0].overloaded).toBeUndefined()
  })

  it('祖先 at-rule 由内向外反转成外层在前', () => {
    const ancestors = formatCssAncestors({
      ruleTypes: ['ContainerRule', 'MediaRule', 'LayerRule'],
      containerQueries: [{ text: '(min-width: 40rem)', name: 'card' }],
      media: [{ text: '(prefers-color-scheme: dark)' }],
      layers: [{ text: 'tokens' }],
    })
    expect(ancestors).toEqual([
      '@layer tokens',
      '@media (prefers-color-scheme: dark)',
      '@container card (min-width: 40rem)',
    ])
  })

  it('嵌套选择器与 @scope 也能展开', () => {
    expect(
      formatCssAncestors({
        ruleTypes: ['StyleRule', 'ScopeRule'],
        nestingSelectors: ['&:hover'],
        scopes: [{ text: '.card' }],
      }),
    ).toEqual(['@scope .card', '&:hover'])
  })

  it('没有包装时返回 undefined', () => {
    expect(formatCssAncestors({})).toBeUndefined()
  })

  it('来源定位：UA/injected/inspector 用文字，普通规则用 文件名:行号', () => {
    expect(formatCssSource({ origin: 'user-agent' }, new Map())).toBe('user agent stylesheet')
    expect(formatCssSource({ origin: 'injected' }, new Map())).toBe('injected stylesheet')
    expect(formatCssSource({ origin: 'inspector' }, new Map())).toBe('via inspector')

    const sheets = new Map([
      [
        '1',
        { styleSheetId: '1', sourceURL: 'https://humble.test/assets/site.css?v=9', startLine: 0 },
      ],
    ])
    expect(
      formatCssSource(
        { origin: 'regular', styleSheetId: '1', style: { range: { startLine: 4 } } },
        sheets,
      ),
    ).toBe('site.css:5')

    expect(
      formatCssSource({ origin: 'regular', style: { range: { startLine: 2 } } }, new Map()),
    ).toBe('<style>:3')
    expect(
      formatCssSource({ origin: 'regular', styleSheetId: 'missing' }, new Map()),
    ).toBeUndefined()
  })

  it('文件名从 URL 推导', () => {
    expect(filenameFromUrl('https://x/y/app.css?v=1#z')).toBe('app.css')
    expect(filenameFromUrl('data:text/css,body{}')).toBe('data-uri')
    expect(filenameFromUrl('blob:https://x/abc')).toBe('blob')
    expect(filenameFromUrl(undefined)).toBe('index')
  })
})

describe('截图：几何与格式', () => {
  it('整页 clip 用内容尺寸，从原点开始', () => {
    expect(contentSizeClip({ cssContentSize: { x: 0, y: 0, width: 100, height: 200 } })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 200,
    })
    expect(contentSizeClip({ contentSize: { x: 0, y: 0, width: 0, height: 0 } })).toBeUndefined()
  })

  it('滚动偏移取 cssVisualViewport（视口坐标 → 页面坐标）', () => {
    expect(viewportOffset({ cssVisualViewport: { pageX: 5, pageY: 7 } })).toEqual({ x: 5, y: 7 })
    expect(viewportOffset({})).toEqual({ x: 0, y: 0 })
  })

  it('元素 clip = 框模型 + 滚动偏移', () => {
    const quad = [10, 20, 30, 20, 30, 40, 10, 40]
    expect(elementClipFromBoxModel(quad, { x: 5, y: 7 })).toEqual({
      x: 15,
      y: 27,
      width: 20,
      height: 20,
    })
    expect(elementClipFromBoxModel([0, 0, 1, 0], { x: 0, y: 0 })).toBeUndefined()
    expect(elementClipFromBoxModel(undefined, { x: 0, y: 0 })).toBeUndefined()
  })

  it('PNG 忽略 quality，其余格式透传', () => {
    expect(resolveScreenshotQuality('png', 50)).toBeUndefined()
    expect(resolveScreenshotQuality('jpeg', 50)).toBe(50)
    expect(resolveScreenshotQuality('webp', undefined)).toBeUndefined()
  })
})
