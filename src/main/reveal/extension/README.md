# Humble 揭示扩展（校准清单）

## 为什么在页面里 fetch

`docs/research/humble-reveal.md` §4.1（已验证）：`POST /humbler/redeemkey` 在**非真实浏览器上下文**一律被
Cloudflare 403（按 HTTP/2 + TLS 指纹识别）；同源 `fetch` 借真 Chrome 指纹 + cookie 才能过。GET 不受影响。

## 必须在首次人工登录时实测确认

| 项 | 说明 |
| --- | --- |
| 订单详情结构 | `findEntry()` 靠递归找 `machine_name === keytype`；**真实 JSON 结构需对照确认**（`tpkd_dict` / `all_tpks` 布局） |
| `keyindex` 字段名 | 研究提醒是 `keyindex`（一个词），**不是 `key_index`**——读错会「0 revealed」 |
| 登录态判定 | 现在用 `/api/v1/user/order` 返回 200 判定；若登录页也 200 需改 |
| CSRF 头 | 现在从可读的 `csrf_cookie` 取 `csrf-prevention-token`；部分来源称同源 fetch **可不带**。若 403 频发，对照 `gfargo` 的失败样本 |
| keyless 分支 | `*_keyless` 揭示会**直接把游戏发放到已绑定账号**（副作用）。当前用「无 keyindex」判定并交人工——需实测确认判据 |

## 实测校准：密钥页真实 DOM（2026-09-26，已登录真实账号）

用 MonoSpace 自带的浏览器能力（`evaluate_script` 只读探测 + a11y 快照）在真实
`https://www.humblebundle.com/home/keys` 上核对出的结构：

| 项 | 实测结果 |
| --- | --- |
| 密钥表 | `table > tr`，表头为 `th.platform` / `th.game-name` / `th.redeemer-cell`；**首页 21 行** |
| **揭示控件** | **`div.keyfield-value`**，文本形如「显示您的 Leartes Studios 密钥」「显示您的 Fab 密钥」；**首页 20 个** |
| 它不是按钮 | 该元素**没有** `button` / `[role=button]`，靠 JS 事件处理器响应点击——**按 `button` 选择器找会 0 命中**，这是之前揭示驱动选不中的根因 |
| a11y 视角 | 在无障碍树里它被合并进单元格的可访问名字里（`cell "显示您的 … 密钥 Redemption Instructions 兑换截止时间是 …"`），**单独一行的 `button` 节点并不存在** |

**因此揭示驱动应当**：定位 `tr` 里 `div.keyfield-value`（文本以「显示您的」开头）
→ 取其矩形中心点击（真实 CDP 输入事件），**不要**依赖 `button` 选择器。

> 仍未实测：点击后展开的详情区结构（兑换码容器）、分页推进方式（首页标注 48 页）。
> 这两项必须在**人工在场**时做一次真实揭示才能确认。
