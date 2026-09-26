# Humble Bundle「揭示 key」研究摘要
- **揭示 = 写操作**：`POST /humbler/redeemkey`（`keytype=<tpk.machine_name>&key=<order.gamekey>&keyindex=<tpk.keyindex>`）会分配 key 并在 Humble 侧标记已领取，不可逆；`*_keyless` 揭示会直接发放到已绑定的 Epic/GOG/Ubisoft 账号。
- **硬边界是 Cloudflare**：GET `/api/v1/*` 裸 curl 可用（`/api/v1/user/order` 未登录 401，`/api/v1/orders` 返回 200 `{}`）；所有状态变更 POST（`/humbler/redeemkey`、`/humbler/choosecontent`、`/processlogin`）在非真实浏览器指纹下被 WAF **403 硬拦**，headless 也不行，必须走真实浏览器 `fetch()`。
- **会话可长期复用**：凭据仅 `_simpleauth_sess`（`base64|ts|hash`，HttpOnly）；匿名 cookie 实测存活 90 天，登录态寿命未验证。范式=首次真实浏览器登录(含 2FA/Guard/reCAPTCHA) → 存 cookie/storage_state → 复用。
- **数据面**：`/api/v1/user/order` + `/api/v1/order/<k>?all_tpkds=true`（含 key）；Choice 走 `/membership/<slug>` 内嵌 `#webpack-monthly-product-data`；Trove 目录 `GET /client/catalog` 甚至**公开可读**（66 项）。
- **人机校验是 Google reCAPTCHA v2**（recaptcha.net，sitekey 可读），另有 Authy/Google Authenticator TOTP 与邮件 Humble Guard；未见 hCaptcha/Turnstile。
- **条款风险**：robots.txt 明文禁爬取与 AI 训练；ToS 禁自动化超人类频率访问与绕过访问控制，并保留随时封号权；未见公开封号实例。已交叉验证 ≥8 个真实开源实现的端点。
- 产物：`docs/research/humble-reveal.md`（分支 `research/humble-reveal`，验证日期 2026-09-26）。
- 未验证项 10 条（登录态 cookie 真实寿命、封号实例、CSRF 头严格必要性、`/api/v1/orders` 语义、`freegame`/`softwarebundle` 厂商流程、Choice `parent_identifier`、过期字段权威性、hCaptcha 等），详见 §6。
