import { describe, expect, it } from 'vitest'
import {
  contentSizeClip,
  elementClipFromBoxModel,
  filterConsoleMessages,
  filterNetworkRequests,
  flattenPreservedHistory,
  formatConsoleArgs,
  formatStackTrace,
  groupConsecutiveConsoleMessages,
  mergeHeaders,
  normalizeConsoleType,
  paginate,
  pushPreservedHistory,
  resolveScreenshotQuality,
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
