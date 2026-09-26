import { describe, expect, it } from 'vitest'
import {
  buildRevealProbeScript,
  extractKeyCode,
  isRevealPlaceholder,
  parseProbeResult,
  pickRevealCandidate,
  type RevealCandidate,
  readCellState,
} from '../page-reader'

/** 实测过的真实文案：揭示前是「显示您的 … 密钥」。 */
const PLACEHOLDER_TEXT = '显示您的 Leartes Studios 密钥 Redemption Instructions'
const REVEALED_TEXT = 'ABCDE-FGHIJ-KLMNO 兑换截止时间是 2027年8月17日'

function candidate(over: Partial<RevealCandidate> = {}): RevealCandidate {
  return { x: 10, y: 20, rowText: '', controlText: '', visible: true, ...over }
}

describe('占位文案判定（实测：显示您的 … 密钥）', () => {
  it('实测中文占位命中', () => {
    expect(isRevealPlaceholder(PLACEHOLDER_TEXT)).toBe(true)
    expect(isRevealPlaceholder('显示您的 Fab 密钥')).toBe(true)
  })

  it('英文站兜底也认', () => {
    expect(isRevealPlaceholder('Reveal your key')).toBe(true)
  })

  it('已经是密钥就不算占位', () => {
    expect(isRevealPlaceholder(REVEALED_TEXT)).toBe(false)
  })
})

describe('抽密钥', () => {
  it('从带噪音的文本里抽出码', () => {
    expect(extractKeyCode(REVEALED_TEXT)).toBe('ABCDE-FGHIJ-KLMNO')
  })

  it('占位文案抽不出码（否则会把「显示您的…」当密钥）', () => {
    expect(extractKeyCode(PLACEHOLDER_TEXT)).toBeNull()
  })

  it('什么都没有时返回 null（调用方据此走接口兜底）', () => {
    expect(extractKeyCode('')).toBeNull()
    expect(extractKeyCode('兑换截止时间是 2027年8月17日')).toBeNull()
  })
})

describe('格子状态', () => {
  it('有码 → 已揭示', () => {
    expect(readCellState(candidate({ controlText: REVEALED_TEXT }))).toBe('revealed')
  })

  it('占位 → 未揭示', () => {
    expect(readCellState(candidate({ controlText: PLACEHOLDER_TEXT }))).toBe('needs-reveal')
  })

  it('两者都不是 → 未知（保守，不猜）', () => {
    expect(readCellState(candidate({ controlText: 'something else' }))).toBe('unknown')
  })
})

describe('按台账身份挑格子', () => {
  it('资产名命中优先', () => {
    const rows = [
      candidate({ rowText: '10 Creatures (Pack) Blades, Blasters & Beasts' }),
      candidate({ rowText: '14 Orcs Pack Blades, Blasters & Beasts' }),
    ]
    expect(pickRevealCandidate(rows, { name: '14 Orcs Pack' })?.rowText).toContain('14 Orcs')
  })

  it('资产名没命中时退回包名', () => {
    const rows = [candidate({ rowText: 'Whatever bt25_bestleartes' })]
    expect(pickRevealCandidate(rows, { name: '不存在', keytype: 'bt25_bestleartes' })).toBeDefined()
  })

  it('不可见的格子跳过', () => {
    const rows = [candidate({ rowText: '目标资产 甲', visible: false })]
    expect(pickRevealCandidate(rows, { name: '目标资产' })).toBeUndefined()
  })

  it('都没命中 → undefined（不瞎点）', () => {
    expect(pickRevealCandidate([candidate({ rowText: '无关' })], { name: '目标' })).toBeUndefined()
  })
})

describe('探测脚本与回执收敛', () => {
  it('脚本只查揭示控件，不在页面里点击（点击由 CDP 真实输入做）', () => {
    const script = buildRevealProbeScript()
    expect(script).toContain('.keyfield-value')
    expect(script).not.toContain('.click(')
  })

  it('回执里混入垃圾时被过滤掉', () => {
    const parsed = parseProbeResult([
      { x: 1, y: 2, rowText: 'a', controlText: 'b', visible: true },
      { x: 'nan', y: 2 },
      null,
      'junk',
      { x: 3, y: 4, visible: 'yes' },
    ])
    expect(parsed).toHaveLength(2)
    expect(parsed[1]).toMatchObject({ x: 3, y: 4, visible: false })
  })

  it('非数组一律当空（页面可能返回任何东西）', () => {
    expect(parseProbeResult(undefined)).toEqual([])
    expect(parseProbeResult({})).toEqual([])
  })
})
