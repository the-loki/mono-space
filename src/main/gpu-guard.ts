/**
 * GPU 兜底（`#20` 验收缺口）。
 *
 * 现象：GPU 进程起不来时 Chromium 不是降级，而是直接 **FATAL 退出**
 * （本机联调反复踩到：`FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:417]
 * GPU process isn't usable. Goodbye.` + SIGTRAP/SIGILL）。
 * 对「装完即启动」是硬伤：用户双击图标，窗口压根不出来。
 *
 * 做法（哨兵式崩溃恢复）：
 * 1. 启动时先看有没有上次留下的哨兵
 * 2. 有 → 说明上次没跑起来 → 这次**禁用硬件加速**，退回软件渲染
 * 3. 无论哪条路，都重新埋哨兵；能稳定跑过 `STABLE_MS` 再把哨兵删掉
 *
 * 这样最多牺牲一次启动的 GPU 加速，之后一旦确认稳定就自动恢复硬件加速。
 */

/** 跑过这么久就算「这次没崩」——比「启动成功」保守，但不需要判断窗口加载状态。 */
export const STABLE_MS = 20_000

export interface GpuGuardDeps {
  sentinelExists(): boolean
  writeSentinel(): void
  removeSentinel(): void
  disableGpu(): void
}

export interface GpuGuardHandle {
  /** 本次是否因为上次崩溃而退回了软件渲染。 */
  recovered: boolean
  /** 稳定运行后调用：清掉哨兵，下次恢复硬件加速。 */
  markHealthy(): void
}

export function runGpuGuard(deps: GpuGuardDeps): GpuGuardHandle {
  const recovered = deps.sentinelExists()
  if (recovered) deps.disableGpu()
  deps.writeSentinel()
  return {
    recovered,
    markHealthy: () => deps.removeSentinel(),
  }
}
