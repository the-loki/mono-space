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
