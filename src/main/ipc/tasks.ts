/**
 * 动作 IPC：只剩「登录」这一条链路（`#25`）。
 *
 * 契约（本文件只注册这一个通道）：
 *   - `tasks:login`  ()      -> LoginWindowResult[]
 *
 * 登录会**打开可见窗口**（人可随时接管：2FA / 验证码）。这是**人**要做的动作，
 * 与 agent 无关，所以留在 UI。
 *
 * **揭示与兑换都不在这里**：两者都已改为**代理驱动**——由内置 agent 在页面上
 * 操作页面自己的控件完成（揭示见 ADR-0003，兑换见 ADR-0005 与 `agent/prompts.ts`）。
 *
 * 页面地址（登录页）不在这里：那是「页面」的领域知识，见 `browser/store-urls.ts`。
 */
import { ipcMain } from 'electron'
import type { LoginWindowResult } from '../../shared/ipc-contract'
import { getStoreSession } from '../browser/store-session'
import { LOGIN_URLS } from '../browser/store-urls'
import { openStoreView } from '../browser/store-view'

export const TASK_LOGIN_CHANNEL = 'tasks:login'

/** 登录窗口结果过 IPC，形状从共享契约取。 */
export type { LoginWindowResult }

/**
 * 打开 Humble / Epic 的登录页（可见窗口）。
 *
 * 登录态落在 `persist:store` 分区，之后的同步（`sync:run`）与 agent 的页面操作
 * 都复用同一个分区，所以在这里登录一次即可。
 */
async function runLogin(): Promise<LoginWindowResult[]> {
  const storeSession = getStoreSession()
  const results: LoginWindowResult[] = []
  for (const [store, url] of Object.entries(LOGIN_URLS)) {
    const view = await openStoreView(storeSession, url, { show: true })
    results.push({
      store,
      requestedUrl: url,
      url: view.url,
      status: view.status,
      title: view.title,
    })
  }
  return results
}

/** 注册动作 IPC。重复调用安全。 */
export function registerTaskIpc(): void {
  ipcMain.removeHandler(TASK_LOGIN_CHANNEL)
  ipcMain.handle(TASK_LOGIN_CHANNEL, () => runLogin())
}
