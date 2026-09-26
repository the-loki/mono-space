/**
 * 揭示页面的**纯逻辑**（`#27` 用户决策：默认走浏览器，接口兜底）。
 *
 * 为什么单独成文件：页面结构会变、而且当前**尚未用真实揭示校准**（用户要求先不点），
 * 所以把「文案判断 / 密钥抽取 / 行匹配 / 探测脚本」做成纯函数，
 * 既好测，也能在将来校准后只改这一处。
 *
 * 实测已知（见 `docs/verify/19-v1-acceptance.md` 的「实测校准」节）：揭示控件是 `div.keyfield-value`，
 * 文案形如「显示您的 Leartes Studios 密钥」，**不是** `<button>`。
 */

/** 揭示前的占位文案（中文界面实测；英文站兜底）。 */
const PLACEHOLDER = /显示您的.{0,40}?密钥|reveal\s+your/i

/**
 * 密钥的形状：
 * - 分段式（Humble 的 Steam 码实测是 `ABCDE-FGHIJ-KLMNO`，**每段只有 5 位**）
 * - 纯十六进制式（Epic 码是 32 位 hex，中间不一定有连字符）
 *
 * 刻意放宽——宁可抽错让接口兜底，也不要因为格式猜太窄而读不到。
 * （第一版写成每段 ≥6 位，测试直接把 `ABCDE-FGHIJ-KLMNO` 判漏了。）
 */
const KEY_LIKE = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{2,})+\b|\b[A-F0-9]{16,}\b/

/** 页面上的噪音（说明文字 / 截止时间），抽码前先剔除。 */
const NOISE = /redemption\s+instructions|兑换截止时间|您还剩余|显示您的|reveal\s+your/gi

export interface RevealIdentity {
  /** 资产名（台账里的 `key.name`）。 */
  name?: string | null
  /** 资产包 machine_name（台账里的 keytype）。 */
  keytype?: string | null
  /** 该包内的第几条。 */
  keyindex?: number
}

/** 页面上一个可揭示的格子（由探测脚本产出）。 */
export interface RevealCandidate {
  /** 视口坐标（点击落点）。 */
  x: number
  y: number
  /** 整行可见文本。 */
  rowText: string
  /** 揭示控件自身的文本。 */
  controlText: string
  /** 是否可见（尺寸非零）。 */
  visible: boolean
}

/** 该格子的揭示状态。 */
export type RevealCellState = 'needs-reveal' | 'revealed' | 'unknown'

/** 文案是否是「还没揭示」的占位（实测「显示您的 … 密钥」）。 */
export function isRevealPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text ?? '')
}

/**
 * 从一段文本里抽密钥。
 *
 * 先剔掉说明/截止时间等噪音再匹配；抽不到返回 null（调用方据此走接口兜底）。
 */
export function extractKeyCode(text: string): string | null {
  if (!text) return null
  const cleaned = text.replace(NOISE, ' ')
  if (isRevealPlaceholder(cleaned)) return null
  const match = cleaned.match(KEY_LIKE)
  return match ? match[0] : null
}

/** 判定单个格子状态。有码 → 已揭示；占位文案 → 未揭示；两者都没有 → 未知。 */
export function readCellState(candidate: RevealCandidate): RevealCellState {
  if (extractKeyCode(candidate.controlText) ?? extractKeyCode(candidate.rowText)) return 'revealed'
  if (isRevealPlaceholder(candidate.controlText) || isRevealPlaceholder(candidate.rowText)) {
    return 'needs-reveal'
  }
  return 'unknown'
}

/** 归一化用于匹配的文本：折叠空白、小写。 */
function normalize(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 按台账里的身份挑出目标格子。
 *
 * 匹配优先级：资产名命中 > 包名命中。**命中多个时返回第一个可见的**——
 * 同一资产包里有多个 key（不同 keyindex）时页面只显示资产名，无法从文案区分，
 * 所以这种情况交给**接口兜底**去确认（见 `page-driver.ts` 的 probe）。
 */
export function pickRevealCandidate(
  candidates: readonly RevealCandidate[],
  identity: RevealIdentity,
): RevealCandidate | undefined {
  const visible = candidates.filter((candidate) => candidate.visible)
  const name = normalize(identity.name)
  const keytype = normalize(identity.keytype)

  const byName = name
    ? visible.filter((candidate) => normalize(candidate.rowText).includes(name))
    : []
  if (byName.length > 0) return byName[0]

  const byKeytype = keytype
    ? visible.filter((candidate) => normalize(candidate.rowText).includes(keytype))
    : []
  return byKeytype[0]
}

/**
 * 探测脚本：找出页面上全部揭示控件，返回坐标与文本。
 *
 * 这是**本 App 自己写死**的脚本（不是 agent 传入的代码）；点击仍走 CDP 真实输入事件，
 * 所以拿到的是可信点击，而不是脚本里的 `el.click()`。
 */
export function buildRevealProbeScript(selector = '.keyfield-value'): string {
  return `(() => {
  const controls = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  return controls.map((el) => {
    const row = el.closest('tr') || el.parentElement;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      rowText: row ? (row.innerText || '') : '',
      controlText: el.innerText || '',
      visible: rect.width > 0 && rect.height > 0,
    };
  });
})()`
}

/** 校验并收敛探测脚本的返回值（页面可能给出任何形状）。 */
export function parseProbeResult(value: unknown): RevealCandidate[] {
  if (!Array.isArray(value)) return []
  const out: RevealCandidate[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const x = Number(record.x)
    const y = Number(record.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push({
      x,
      y,
      rowText: typeof record.rowText === 'string' ? record.rowText : '',
      controlText: typeof record.controlText === 'string' ? record.controlText : '',
      visible: record.visible === true,
    })
  }
  return out
}
