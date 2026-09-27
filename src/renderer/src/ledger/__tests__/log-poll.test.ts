import { describe, expect, it } from 'vitest'
import { LOG_POLL_IDLE_MS, LOG_POLL_RUNNING_MS, logPollIntervalMs } from '../log-poll'

describe('调试日志面板的轮询策略', () => {
  it('运行中比空闲更密（运行中 2.5s / 空闲 5s）', () => {
    expect(logPollIntervalMs(true)).toBe(LOG_POLL_RUNNING_MS)
    expect(logPollIntervalMs(false)).toBe(LOG_POLL_IDLE_MS)
    expect(LOG_POLL_RUNNING_MS).toBeLessThan(LOG_POLL_IDLE_MS)
  })

  it('★ 空闲时**也要**返回一个有限间隔（回归：曾返回「不轮询」，导致开着面板看不到新任务）', () => {
    const idle = logPollIntervalMs(false)
    expect(Number.isFinite(idle)).toBe(true)
    expect(idle).toBeGreaterThan(0)
  })

  it('间隔是个能被 setInterval 直接用的整数毫秒数', () => {
    for (const running of [true, false]) {
      const ms = logPollIntervalMs(running)
      expect(Number.isInteger(ms)).toBe(true)
      expect(ms).toBeGreaterThanOrEqual(1000)
    }
  })
})
