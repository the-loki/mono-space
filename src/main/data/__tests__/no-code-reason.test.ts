/**
 * 无码缘由的**取值收敛**（与 platform 同一条硬边界，见 ADR-0006 的「边界」一节）。
 *
 * 这里钉住三件事：命中枚举才用、非空但认不出的落 `unknown`、空 / 非字符串落 `null`；
 * 以及**永不抛错**——取值收敛必须能扛住任何输入，绝不因为一行取值奇怪就让调用方炸掉。
 */
import { describe, expect, it } from 'vitest'
import { NO_CODE_REASONS, normalizeNoCodeReason } from '../no-code-reason'

describe('normalizeNoCodeReason：无码缘由取值收敛', () => {
  it('命中枚举的值原样通过（大小写与首尾空白先归一）', () => {
    for (const value of ['expired', 'exhausted', 'link_only', 'unknown']) {
      expect(normalizeNoCodeReason(value)).toBe(value)
    }
    expect(normalizeNoCodeReason('  Expired ')).toBe('expired')
    expect(normalizeNoCodeReason('LINK_ONLY')).toBe('link_only')
    expect(normalizeNoCodeReason('\tUnknown\n')).toBe('unknown')
  })

  it('非空但无法识别的取值 → unknown（不报错，也不把原值原样落库）', () => {
    for (const value of ['bogus', '已过期', 'expired!', 'expired_or_not', '123', 'null']) {
      expect(normalizeNoCodeReason(value)).toBe('unknown')
    }
  })

  it('空 / 纯空白 / 非字符串 → null（＝「有码」或「还没判定」）', () => {
    const nullish: unknown[] = [
      null,
      undefined,
      '',
      '   ',
      '\n\t ',
      42,
      0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      true,
      false,
      {},
      [],
    ]
    for (const value of nullish) {
      expect(normalizeNoCodeReason(value)).toBeNull()
    }
  })

  it('永不抛错：任何输入都返回合法结果（符号 / BigInt / 日期也不例外）', () => {
    const weird: unknown[] = [Symbol('x'), BigInt(1), new Date(), () => {}, new Map()]
    for (const value of weird) {
      expect(() => normalizeNoCodeReason(value)).not.toThrow()
      expect(normalizeNoCodeReason(value)).toBeNull()
    }
  })

  it('枚举常量就是约定的四个值（顺序即枚举顺序）', () => {
    expect([...NO_CODE_REASONS]).toEqual(['expired', 'exhausted', 'link_only', 'unknown'])
  })
})
