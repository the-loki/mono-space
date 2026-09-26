/**
 * MCP 宿主（`#31`）：把 MonoSpace 的领域能力与**忠实镜像的浏览器能力**接起来。
 *
 * 本文件是**组合根**：两半各自成模块，这里只建共享的审计并拼成一个 `McpHost`：
 * - `host-browser.ts` —— 浏览器适配器（`BrowserHost` 的唯一实现：快照引用 / 导航 / 脱敏 / 当前页）；
 * - `host-ledger.ts` —— 台账适配器（统计数据来源 / 落库 / 揭示 / 兑换，含 ADR-0003 落库入口）；
 * - `host-audit.ts` —— 两半共享的留痕。
 *
 * 工具层只面向这一个宿主的接口（`tools.ts` 的 `McpHost`），由下面的组合给出。
 */
import { createAuditLogger } from './host-audit'
import { createBrowserHost } from './host-browser'
import { createLedgerHost } from './host-ledger'
import type { McpHost } from './tools'

// 脱敏函数的既有出口仍留在本模块（`tools.test.ts` 从 `../host` 取）。
export { redactAccountTitle, redactSnapshotText } from './host-browser'

/** 建 MCP 宿主：一份审计，注入浏览器半与台账半。 */
export function createMcpHost(): McpHost {
  const audit = createAuditLogger()
  return {
    ...createBrowserHost(audit),
    ...createLedgerHost(audit),
  }
}
