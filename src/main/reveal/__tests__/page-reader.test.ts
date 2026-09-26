import { describe, expect, it } from 'vitest'
import {
  buildRevealProbeScript,
  decideProbeFallback,
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

describe('decideProbeFallback：接口只核对，取码必须走页面', () => {
  it('接口说已揭示、页面却没码 → 交人工，且**绝不把接口的码当答案**', () => {
    const result = decideProbeFallback({ crossCheck: 'revealed' })
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.pause).toBe('unknown-page')
      expect(result.detail).toContain('页面上没读到密钥')
    }
    // 结构性保证：判定结果里根本不可能出现形如密钥的串
    expect(JSON.stringify(result)).not.toMatch(/[A-Z0-9]{4,}-[A-Z0-9]{4,}/)
  })

  it('接口说订单里没这条 key → 交人工（这是「查缺口」的用法）', () => {
    const result = decideProbeFallback({ crossCheck: 'missing' })
    expect(result).toMatchObject({ kind: 'unavailable', pause: 'unavailable' })
  })

  it('接口说未揭示、页面又没控件 → 交人工，不猜着点（不可逆）', () => {
    const result = decideProbeFallback({ crossCheck: 'unrevealed' })
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') expect(result.detail).toContain('定位不到揭示控件')
  })

  it('接口核对报错 → 交人工并把原因带出来', () => {
    const result = decideProbeFallback({ crossCheck: 'error', errorDetail: 'HTTP 500' })
    expect(result).toMatchObject({ kind: 'unavailable', detail: 'HTTP 500' })
  })

  it('没接接口（crossCheck=null）→ 纯靠页面，交人工', () => {
    const result = decideProbeFallback({ crossCheck: null })
    expect(result).toMatchObject({ kind: 'unavailable', pause: 'unknown-page' })
  })
})

/**
 * 真实页面抓下来的两条候选（2026-09-26 取自 /downloads?key=52YH6x4ubXAB5qwr）。
 *
 * 保留原因：**揭示路径曾经是死的** —— 探测脚本用 `closest('tr')`，而订单页是 div、没有 tr，
 * 回退到 parentElement 只拿到「只有码」的那层，资产名不在 rowText 里；再叠加 driver 只传机器名，
 * 于是永远定位不到控件、每次都「交人工」。这两条 fixture 把这个坑钉住。
 */
const REAL_PAGE_CANDIDATES: RevealCandidate[] = [
  {
    x: 1,
    y: 1,
    visible: true,
    controlText: '6ZVZW-99C3F-HR9Z4-E5WXZ',
    rowText:
      'Astronauts (Pack)\n6ZVZW-99C3F-HR9Z4-E5WXZ\nRedemption Instructions\n\n兑换截止时间是 2027年4月30日 GMT-7 11:00:00。您还剩余 216 天！',
  },
  {
    x: 2,
    y: 2,
    visible: true,
    controlText: '643BT-M3GQM-EPKZZ-DWF2U',
    rowText:
      'Creatures Insects (Pack)\n643BT-M3GQM-EPKZZ-DWF2U\nRedemption Instructions\n\n兑换截止时间是 2027年4月30日 GMT-7 11:00:00。您还剩余 216 天！',
  },
]

describe('揭示控件定位：订单页是 div 不是表格（实测）', () => {
  it('探测脚本要把 rowText 抓到含资产名的那层（.key-redeemer，不只是 parentElement）', () => {
    const script = buildRevealProbeScript()
    expect(script).toContain('.key-redeemer')
    expect(script).toContain('tr')
  })

  it('按**显示名**能命中，并且判为已揭示（不需点击）', () => {
    const hit = pickRevealCandidate(REAL_PAGE_CANDIDATES, {
      name: 'Astronauts (Pack)',
      keytype: 'astronautspack_fab',
      keyindex: 0,
    })
    expect(hit).toBeDefined()
    expect(readCellState(hit as RevealCandidate)).toBe('revealed')
    expect(extractKeyCode((hit as RevealCandidate).controlText)).toBe('6ZVZW-99C3F-HR9Z4-E5WXZ')
  })

  it('只给机器名命中不了（这就是原先揭示一直「交人工」的原因）', () => {
    expect(
      pickRevealCandidate(REAL_PAGE_CANDIDATES, {
        name: 'astronautspack_fab',
        keytype: 'astronautspack_fab',
      }),
    ).toBeUndefined()
  })
})
