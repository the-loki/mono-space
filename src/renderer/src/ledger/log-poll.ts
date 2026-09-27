/**
 * 调试日志面板的轮询策略。
 *
 * **为什么要单独一个模块**：这里踩过一次真 bug —— 原先的 effect 以 `running` 为依赖，
 * 一轮结束（`running` 变 false）就把 interval 停掉，于是**面板开着时启动的新任务永远不会出现**
 * （实测：主进程缓冲里已有 19 条，面板停在「0 条 / 暂无记录」，点一次「刷新」才补上）。
 *
 * 结论：**空闲也必须持续轮询**，只是可以慢一点。把这条策略写成纯函数，是为了让它能被测试钉住，
 * 而不是埋在 JSX 的 effect 里靠人记住。
 */

/** 运行中：够看到过程，又不高频空转。 */
export const LOG_POLL_RUNNING_MS = 2500

/** 空闲：慢一倍。仍然**不能停** —— 停了就看不到「刚启动的新任务」。 */
export const LOG_POLL_IDLE_MS = 5000

/** 当前该用哪个轮询间隔（永远返回一个正数，绝不返回「不轮询」）。 */
export function logPollIntervalMs(running: boolean): number {
  return running ? LOG_POLL_RUNNING_MS : LOG_POLL_IDLE_MS
}
