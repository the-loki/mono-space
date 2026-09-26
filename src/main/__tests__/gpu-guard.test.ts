import { describe, expect, it, vi } from 'vitest'
import { runGpuGuard } from '../gpu-guard'

function deps(sentinelExists: boolean) {
  return {
    sentinelExists: vi.fn(() => sentinelExists),
    writeSentinel: vi.fn(),
    removeSentinel: vi.fn(),
    disableGpu: vi.fn(),
  }
}

describe('GPU 兜底', () => {
  it('上次没崩：不动硬件加速，只埋哨兵', () => {
    const d = deps(false)
    const guard = runGpuGuard(d)
    expect(guard.recovered).toBe(false)
    expect(d.disableGpu).not.toHaveBeenCalled()
    expect(d.writeSentinel).toHaveBeenCalledTimes(1)
  })

  it('上次崩过：禁用硬件加速（否则会一直 FATAL 崩到用户放弃）', () => {
    const d = deps(true)
    const guard = runGpuGuard(d)
    expect(guard.recovered).toBe(true)
    expect(d.disableGpu).toHaveBeenCalledTimes(1)
    expect(d.writeSentinel).toHaveBeenCalledTimes(1)
  })

  it('稳定运行后清哨兵 → 下次自动恢复硬件加速', () => {
    const d = deps(true)
    runGpuGuard(d).markHealthy()
    expect(d.removeSentinel).toHaveBeenCalledTimes(1)
  })
})
