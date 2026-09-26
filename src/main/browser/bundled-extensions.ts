/**
 * 装载内置扩展（兑换 / 揭示）到 store 会话。
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
      await loadStoreExtension(storeSession, resolveExtensionPath('reveal-extension'))
      await loadStoreExtension(storeSession, resolveExtensionPath('redeem-extension'))
    })()
  }
  return loading
}

/** 仅供测试断言「是否已装过」。 */
export function resetBundledExtensions(): void {
  loading = null
}
