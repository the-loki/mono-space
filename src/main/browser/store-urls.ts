/**
 * store 的页面地址知识：Humble 订单页 / Epic 兑换页 / 两个 store 的登录页（`#12` / `#25` / `#26`）。
 *
 * 为什么住在「页面」模块而不是 IPC 注册模块：打开哪一张页面是「页面」这一概念的领域知识，
 * 消费者是浏览器宿主（agent 用它开订单页）与兑换/登录流程；通道注册只负责把流程接到渲染进程。
 * 这里就是全仓唯一的地址来源。
 */

/** 两个 store 的登录入口（`docs/spec/14` §7「首次运行引导」）。 */
export const LOGIN_URLS: Record<string, string> = {
  humble: 'https://www.humblebundle.com/login',
  epic: 'https://www.epicgames.com/id/login',
}

/**
 * 某一单的专属页：**只列这一单的 key、没有分页**（实测 `/download?key=` 会 302 到这里）。
 *
 * 为什么揭示走它而不是 `/home/keys`：密钥页有 48 页分页、952 个 key 挤在一起，要在里面认出
 * 「这一条」的控件既慢又容易认错（认错就会点到别的 key —— 不可逆）。订单页只有这一单的条目，
 * 定位可靠得多；而且**已揭示的 key 在这个页面上本来就直接显示码**，不需要点。
 *
 * 约束：码只从页面读（见 `page-reader.ts` 的 `CrossCheckState`），接口只做核对与查缺口。
 */
export function humbleOrderUrl(gamekey: string): string {
  return `https://www.humblebundle.com/downloads?key=${encodeURIComponent(gamekey)}`
}

/** Epic 账号兑换页（`#12`）。 */
export const EPIC_REDEEM_URL = 'https://www.epicgames.com/account/code-redemption'
