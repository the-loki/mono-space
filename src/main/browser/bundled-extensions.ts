/**
 * 装载内置扩展（**只剩兑换**）到 store 会话。
 *
 * 揭示扩展已删除（`#27` 用户决策）：揭示改为**操作页面自己的控件**，
 * 不需要再有扩展替你在页面里 `fetch`。
 *
 * 约束（`docs/verify/16-embedded-browser.md`）：只能装进 `persist:` 分区，
 * 且每次启动都要重新 `loadExtension`（不能装 `.crx`）。
 *
 * **必须在打开目标页之前装好**——content script 只对「装载后新加载的页面」注入。
 */
import type { Session } from 'electron'
import { loadStoreExtension } from './extension-host'
import { resolveExtensionPath } from './extension-path'

let loading: Promise<void> | null = null

/** 幂等：同一进程内只装一次（并发调用共享同一个 promise）。 */
export function ensureBundledExtensions(storeSession: Session): Promise<void> {
  if (!loading) {
    loading = (async () => {
      await loadStoreExtension(storeSession, resolveExtensionPath('redeem-extension'))
    })()
  }
  return loading
}

/** 仅供测试断言「是否已装过」。 */
export function resetBundledExtensions(): void {
  loading = null
}
