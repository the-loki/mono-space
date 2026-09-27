import { describe, expect, it } from 'vitest'
import {
  AGENT_LOG_SUMMARY_LIMIT,
  AGENT_LOG_TURN_TEXT_LIMIT,
  appendBounded,
  createAgentLogBuffer,
  summarizeArgs,
  TRUNCATION_MARK,
  truncate,
} from '../log-buffer'

describe('appendBounded：追加并裁剪到上限（纯函数）', () => {
  it('未超上限时原样追加，保持顺序', () => {
    expect(appendBounded([1, 2], 3, 5)).toEqual([1, 2, 3])
  })

  it('超上限时丢最旧的，保留最新的 capacity 条且顺序不变', () => {
    expect(appendBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
    expect(appendBounded([1, 2, 3, 4], 5, 3)).toEqual([3, 4, 5])
  })

  it('返回新数组，不改动入参（纯）', () => {
    const original = [1, 2]
    const next = appendBounded(original, 3, 5)
    expect(original).toEqual([1, 2])
    expect(next).not.toBe(original)
  })

  it('capacity 为 0 时只留空', () => {
    expect(appendBounded([1], 2, 0)).toEqual([])
  })
})

describe('truncate：超长截断', () => {
  it('短文本原样保留', () => {
    expect(truncate('abc', 10)).toBe('abc')
  })

  it('恰好等于上限时不动它', () => {
    expect(truncate('abcde', 5)).toBe('abcde')
  })

  it('超长时截到上限并以标记收尾', () => {
    const result = truncate('abcdefghij', 5)
    expect(result).toBe(`abcd${TRUNCATION_MARK}`)
    expect(result.length).toBe(5)
    expect(result.endsWith(TRUNCATION_MARK)).toBe(true)
  })
})

describe('summarizeArgs：参数摘要（必须有截断）', () => {
  it('短参数原样保留为 JSON', () => {
    expect(summarizeArgs({ keyId: 7 })).toBe('{"keyId":7}')
  })

  it('超长参数被截断，总长不超过上限', () => {
    const huge = JSON.stringify({ dom: 'x'.repeat(5000) })
    const result = summarizeArgs(huge)
    expect(result.length).toBe(AGENT_LOG_SUMMARY_LIMIT)
    expect(result.endsWith(TRUNCATION_MARK)).toBe(true)
  })

  it('非对象参数也安全（字符串 / 数字 / null）', () => {
    expect(summarizeArgs('hi')).toBe('"hi"')
    expect(summarizeArgs(42)).toBe('42')
    expect(summarizeArgs(null)).toBe('null')
  })

  it('undefined 摘要为空串（不产出 "undefined"）', () => {
    expect(summarizeArgs(undefined)).toBe('')
  })

  it('循环引用不抛错，并留下可辨标记', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(() => summarizeArgs(circular)).not.toThrow()
    expect(summarizeArgs(circular)).toContain('[Circular]')
  })

  it('BigInt / 函数等 JSON 默认会抛的值有兜底', () => {
    expect(summarizeArgs(10n)).toContain('10n')
    expect(summarizeArgs(() => 1)).toContain('[Function]')
  })
})

describe('createAgentLogBuffer：事件合并与环形裁剪', () => {
  it('run_start 记录 prompt 摘要、run_end 记录最终状态', () => {
    const buffer = createAgentLogBuffer()
    buffer.runStart('看看当前页面')
    buffer.runEnd({ ok: false, detail: '模型报错' })
    const snapshot = buffer.snapshot()
    // 最新在前
    expect(snapshot.map((entry) => entry.kind)).toEqual(['run_end', 'run_start'])
    expect(snapshot[1].detail).toBe('看看当前页面')
    expect(snapshot[0].failed).toBe(true)
    expect(snapshot[0].detail).toBe('模型报错')
  })

  it('工具调用按 callId 合并成一条：起点带参数摘要，终点补结果与失败标记', () => {
    const buffer = createAgentLogBuffer()
    buffer.toolStart({
      callId: 'c1',
      tool: 'monospace_keys_ingest',
      args: { orderGamekey: 'abc', keys: [{ name: 'x' }] },
    })
    buffer.toolEnd({
      callId: 'c1',
      tool: 'monospace_keys_ingest',
      result: { written: 2 },
      isError: false,
    })
    const snapshot = buffer.snapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].kind).toBe('tool')
    expect(snapshot[0].tool).toBe('monospace_keys_ingest')
    expect(snapshot[0].detail).toContain('abc')
    expect(snapshot[0].result).toContain('written')
    expect(snapshot[0].failed).toBe(false)
    expect(buffer.size()).toBe(1)
  })

  it('工具失败：同一条记录上 failed=true', () => {
    const buffer = createAgentLogBuffer()
    buffer.toolStart({ callId: 'c1', tool: 'monospace_dom', args: {} })
    buffer.toolEnd({ callId: 'c1', tool: 'monospace_dom', result: 'boom', isError: true })
    expect(buffer.snapshot()[0].failed).toBe(true)
    expect(buffer.snapshot()[0].result).toContain('boom')
  })

  it('没有 start 的 end（起点被挤掉等）也补一条结果记录，不丢信息', () => {
    const buffer = createAgentLogBuffer()
    buffer.toolEnd({ callId: 'ghost', tool: 'monospace_act', result: 'late', isError: true })
    const snapshot = buffer.snapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].detail).toBe('')
    expect(snapshot[0].result).toContain('late')
    expect(snapshot[0].failed).toBe(true)
  })

  it('文本增量合并进同一条回合记录；遇到工具调用后开启新回合', () => {
    const buffer = createAgentLogBuffer()
    buffer.runStart('p')
    buffer.pushTextDelta('你好')
    buffer.pushTextDelta('，世界')
    expect(buffer.size()).toBe(2)
    buffer.toolStart({ callId: 'c1', tool: 'monospace_dom', args: {} })
    buffer.pushTextDelta('新回合')
    const kinds = buffer.snapshot().map((entry) => entry.kind)
    // 最新在前：新回合文本、工具、旧回合文本、运行开始
    expect(kinds).toEqual(['turn_text', 'tool', 'turn_text', 'run_start'])
    const turn = buffer.snapshot()[2]
    expect(turn.detail).toBe('你好，世界')
  })

  it('回合文本也有上限，不会无限增长', () => {
    const buffer = createAgentLogBuffer()
    buffer.pushTextDelta('x'.repeat(AGENT_LOG_TURN_TEXT_LIMIT + 500))
    const [entry] = buffer.snapshot()
    expect(entry.detail.length).toBe(AGENT_LOG_TURN_TEXT_LIMIT)
    expect(entry.detail.endsWith(TRUNCATION_MARK)).toBe(true)
  })

  it('超过容量丢最旧的，快照最新在前且 seq 稳定', () => {
    const buffer = createAgentLogBuffer(3)
    for (let index = 0; index < 5; index += 1) {
      buffer.toolStart({ callId: `c${index}`, tool: `t${index}`, args: index })
    }
    expect(buffer.size()).toBe(3)
    const snapshot = buffer.snapshot()
    expect(snapshot.map((entry) => entry.tool)).toEqual(['t4', 't3', 't2'])
    expect(snapshot.map((entry) => entry.seq)).toEqual([5, 4, 3])
  })

  it('快照是拷贝，改它不影响内部状态', () => {
    const buffer = createAgentLogBuffer()
    buffer.runStart('原始')
    const snapshot = buffer.snapshot()
    snapshot[0].detail = '被改了'
    expect(buffer.snapshot()[0].detail).toBe('原始')
  })

  it('clear 清空全部记录', () => {
    const buffer = createAgentLogBuffer()
    buffer.runStart('p')
    buffer.clear()
    expect(buffer.size()).toBe(0)
    expect(buffer.snapshot()).toEqual([])
  })
})

describe('createAgentLogBuffer：运行状态（面板据此自给自足轮询）', () => {
  it('初始为未运行', () => {
    expect(createAgentLogBuffer().isRunning()).toBe(false)
  })

  it('runStart 后为运行中，runEnd 后回到未运行', () => {
    const buffer = createAgentLogBuffer()
    buffer.runStart('p')
    expect(buffer.isRunning()).toBe(true)
    buffer.runEnd({ ok: true, detail: '完成' })
    expect(buffer.isRunning()).toBe(false)
  })

  it('失败结束同样算结束', () => {
    const buffer = createAgentLogBuffer()
    buffer.runStart('p')
    buffer.runEnd({ ok: false, detail: '模型报错' })
    expect(buffer.isRunning()).toBe(false)
  })

  it('没开始就 runEnd：状态保持未运行（幂等）', () => {
    const buffer = createAgentLogBuffer()
    buffer.runEnd({ ok: true, detail: '幽灵结束' })
    expect(buffer.isRunning()).toBe(false)
    // 记录照旧落盘（end 本身是有效事件）。
    expect(buffer.snapshot()).toHaveLength(1)
  })

  it('clear 只清记录，不改运行状态（运行中清空仍是运行中）', () => {
    const buffer = createAgentLogBuffer()
    buffer.runStart('p')
    buffer.clear()
    expect(buffer.snapshot()).toEqual([])
    expect(buffer.isRunning()).toBe(true)
  })

  it('运行中 snapshot 仍是「最新在前的记录数组」（entries 语义不变）', () => {
    const buffer = createAgentLogBuffer()
    buffer.runStart('p')
    const snapshot = buffer.snapshot()
    expect(Array.isArray(snapshot)).toBe(true)
    expect(snapshot.map((entry) => entry.kind)).toEqual(['run_start'])
  })
})
