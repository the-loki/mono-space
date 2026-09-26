---
status: accepted
---

# 内嵌真实浏览器承载登录与写操作，不做纯 API 客户端

应用要登录 Humble Bundle 并「揭示（reveal）」key、再把兑换码提交到 Epic 换进 Fab。直觉方案是直接调 HTTP 接口；实测证伪了这个方案——Humble 与 Fab 都由 Cloudflare 前置，**所有状态变更 POST 在非真实浏览器指纹下一律 403 硬拦，headless 也不行**（Humble 的 `POST /humbler/redeemkey`、`POST /processlogin`；Fab 裸 `curl` 直接 `403 cf-mitigated: challenge`）。因此决定：**内嵌应用自带的 Chromium 承载登录与全部写操作**（Electron `WebContentsView` + 应用私有 `session.fromPartition('persist:…')` 分区），HTTP 接口只用于只读同步；登录会话由用户手动建立一次后长期复用（Humble 只有 `_simpleauth_sess` 一个凭据，匿名实测存活 90 天）；一切人机校验（Humble 的 reCAPTCHA v2 / TOTP / 邮件 Guard，Fab 的 hCaptcha）一律交人工，不尝试绕过。

## Considered Options

- **纯 API 客户端**——被实测证伪：只读面（`GET /api/v1/*`）确实可用，但写面被 Cloudflare 拦截。曾是最省事的方案，已排除，不要重新立项。
- **外接系统浏览器 + 远程调试端口**——被 Chrome 136 起的政策排除：`--remote-debugging-port` 在默认 profile 上失效，必须配 `--user-data-dir`，那就只能是空 profile，「复用已登录态」的前提不成立。
- **内嵌第二套 Chromium（Playwright / Patchright）**——可作退路，但要多带一份浏览器、多背一条版本分叉（与应用自带 Chromium 不一致），相对收益不值。主路径用 Electron 原生 + CDP 足够。

## Consequences

- **应用不能无人值守**：登录、2FA、人机校验、陌生页面都是流程中的常态暂停点，不是异常分支。这条已升格为地图上的长期约束。
- **必须有可见窗口**：Linux 上还要处理 Wayland / X11 的差异（不靠抢焦点或 `setPosition`，用视图内 `setBounds`）。
- **凭据安全性受 Linux 现实限制**：`persist:` 分区数据在无桌面密钥环时走 `--password-store=basic`，cookie 只是混淆而非加密；`safeStorage` 在无 libsecret / KWallet 时会回退 `basic_text`（官方定性 unprotected）。不要在此之上假想更强的保证。
- **条款风险**：Humble `robots.txt` 明文禁爬取，ToS 禁「超出人类频率的自动化」并保留封号权。内嵌浏览器让人在环路成为自然选择，也因此是唯一与条款相容的做法；批量并发访问与此冲突，不做。

证据见 `docs/research/humble-reveal.md`（#2）、`docs/research/store-redemption.md`（#3）、`docs/research/browser-automation-fallback.md`（#6）。
