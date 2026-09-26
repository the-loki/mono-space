# Humble Bundle「揭示 key」可行手段与边界

> Issue: the-loki/mono-space#2 · wayfinder 研究票
> 验证日期（UTC）：2026-09-26
> 方法：直接对 `www.humblebundle.com` 发真实 HTTP 请求抓取公开页面/接口/`robots.txt`/ToS 原文；阅读真实在用的第三方开源客户端源码（GitHub raw）。未登录、未绕过任何人机校验。
> 所有实测的 curl 均使用该 User-Agent：`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36`，出口 IP 为普通云主机。
> 每条结论标注 [已验证]（亲自抓到/读到原文）或 [推断]（由源码或结构推得，未亲测）。

---

## 0. 结论先行（TL;DR）

1. **「揭示 key」不是一个读取接口，而是一个会改状态的写操作。** 端点 `POST /humbler/redeemkey` 会把尚未分配的 key 分配给用户，并在 Humble 侧把该条目标记为已领取（"Redeem 会 reveal **并** 标记 key 为 claimed"）。因此揭示是不可无限重放的资源动作，必须按「已揭示 = 有 `redeemed_key_val`」做幂等判断。
   - 证据：`gfargo/humble-bundle-keys` `api.py` 的 `_reveal()`；`scraper.py` 文档串；`smbl64/humble-cli` issue #190 的 curl 示例。 [已验证：源码/原文]
2. **真正的硬边界是 Cloudflare，不是登录。** 只读 GET 到 `/api/v1/*` 在本机裸 curl 下畅通（返回 200/401 JSON/HTML），但**所有状态变更 POST（`/humbler/redeemkey`、`/humbler/choosecontent`、`/processlogin`）在非真实浏览器指纹下被 Cloudflare 直接 403 硬拦**（返回 "Sorry, you have been blocked" WAF 页，无 `cf_clearance` 可解）。第三方工具的统一结论是：**POST 必须经由真实浏览器（真 Chrome 的 `fetch()`）发出**；headless Chromium 也不行。 [已验证：本机实测 + `gfargo` 源码与 CHANGELOG]
3. **登录会话可以长期复用，且存在「零登录」路径。** 认证凭据就是 `_simpleauth_sess` cookie，形如 `base64({"id":...})|<unix_ts>|<40位hash>`。匿名访问也会下发该 cookie 并存活 **90 天**；第三方工具普遍「首次用真实浏览器登录（含 2FA）→ 保存 cookie/storage state → 之后无头复用，失效再登录」。多个工具甚至支持只传 `_simpleauth_sess` 一个 cookie 就能跑通 GET 类接口。 [已验证：Set-Cookie 实测 + 多份源码]
4. **数据面（个人库/订单/Choice/书籍/软件）几乎全部来自同一组私有 JSON 接口**：`GET /api/v1/user/order`（订单 gamekey 列表）+ `GET /api/v1/order/<gamekey>?all_tpkds=true`（每单详情，含 key）；Humble Choice 月度走 `GET /membership/<slug>` 内嵌 JSON（`<script id="webpack-monthly-product-data">`）。**未登录时 `/api/v1/user/order` 返回 401，而 `/api/v1/orders` 返回 200 `{}`**。 [已验证：逐条实测 + 源码]
5. **ToS 与 `robots.txt` 都明文禁止自动化访问与抓取**。`robots.txt` 由 Ziff Davis 明文禁止爬虫/抓取/AI 训练；ToS §Restrictions 禁止 "automated system … robots, spiders, offline readers" 超人类频率访问，并保留随时封号权利。这属于**条款风险（非技术封锁）**，且现实中主要靠 Cloudflare 技术手段执行。 [已验证：robots.txt / ToS 原文]
6. **reveal 有副作用与「无 key」分支**：`*_keyless`（epic/gog/uplay keyless）揭示会**直接把游戏发放到已绑定的对应商店账号**；`softwarebundle`/`voucher`/`freegame` 揭示不会有 key（厂商流程不同）。 [已验证：issue #190 原文 + `gfargo` 分类逻辑]
7. **对本项目最可行的架构**：应用内置一个「受控的真实浏览器上下文」承担登录 + 所有 POST 揭示动作，`_simpleauth_sess` 之外的所有读取尽量走 GET JSON 接口；把「揭示」当作有副作用的、需限速与幂等的动作单独编排。**纯脚本/纯 API 客户端方案（无浏览器）在 POST 面上不成立。**

---

## 1. 登录流程长什么样

### 1.1 表单与字段（从官方登录页 JS 模板读取）

`GET /login` 返回的 HTML 本身不含 `<form action="/processlogin">`（页面是 JS 渲染）。但登录页加载的官方 bundle `https://cdn.humblebundle.com/static/hashed/0f74c8f4f1c85fe3bf57f12b58f92d1347d0aa49.js` 内含登录模板与逻辑，可直接读到：

- 表单 action：`<form action="/processlogin" method="post">` [已验证：JS 模板字符串]
- 提交参数字段（模型 `getSubmitParams`）：`["goto", "password", "qs", "username", "access_token", "access_token_provider_id"]` [已验证]
- 页面另下发隐藏 input：`<input type="hidden" class="csrftoken" name="_le_csrf_token" value="...">`，键名在 `window.models` / page-data 里叫 `csrfFormKey = "_le_csrf_token"` [已验证：page-data JSON]
- SSO 存在（`showSingleSignOn: true`；字段 `access_token` / `access_token_provider_id` / `id_token` / `oauth_token_secret`） [已验证]

> 历史版本对比：`MestreLion/humblebundle`（2022）把 `_le_csrf_token` 作为**表单字段**连同 `goto/username/password` POST 到 `/processlogin`；`FailSpy/humble-steam-key-redeemer`（2024）改为发 HTTP 头 `csrf-prevention-token: <csrf_cookie 的值>` + 表单 `{access_token, access_token_provider_id, goto, qs, username, password}`。两种口径都存在过。 [已验证：两份源码]

### 1.2 二次校验：Humble Guard / 2FA / SMS

`js_0f74...js` 里可见完整状态机，登录响应 JSON 驱动前端切换视图：

- `two_factor_required` → `active_view = "twoFactor"`，携带 `twofactor_type`（`authy` 或 Google Authenticator）；界面文案："Please enter your Authy code below." / "Please enter your Google Authenticator code below."。提交字段为 `code`。 [已验证：JS 原文]
- `humble_guard_required` → `active_view = "humbleGuard"`（"浏览器验证码"，通常邮件下发）；提交字段 `code`；另有 `POST /user/humbleguard/resend` 携带 `{email, password, access_token, access_token_provider_id}`。 [已验证：JS 原文]
- 短信：`POST /user/authy/send-sms`，body 含 `{requestkey, username, ...}`。 [已验证：JS 原文]
- `FailSpy` 的实测 JSON 分支名与上面一致：错误邮箱/密码 → `errors.username[]`；`humble_guard_required` → `payload["guard"]`（"Humble security codes are case-sensitive via API"，全大写）；`two_factor_required` + `errors["authy-input"]` → `payload["code"]`；若返回 `user_terms_opt_in_data.needs_to_opt_in` 则要求重签 ToS。 [已验证：源码]
- `MestreLion`（2022）用 `GET /user/humbleguard?goto=...&_le_csrf_token=...&code=...`。当前实测 `GET /user/humbleguard` → **404**，说明该路径形态已变（现在走 `/processlogin` 提交，见上）。 [已验证：本机实测]

### 1.3 人机校验：Google reCAPTCHA（不是 hCaptcha / Turnstile）

- 登录页 page-data 里下发 `window.models.request = { country_code: "US", captcha_enabled: true, ... }`。 [已验证]
- `js_0f74...js` 含 `CAPTCHA_CONSTANTS.grecaptcha`：
  `PROD_SITEKEY = 6Lf2JvsSAAAAAEVgWrlS8fa02_x8My6aU7AW34nM`（可见式）、
  `PROD_INVISIBLE_SITEKEY = 6LdsABsUAAAAAAWcUQhPOAGGWP4z9bkKrNaiCeK8`（隐形式）。脚本从 `https://www.recaptcha.net/recaptcha/api.js?render=explicit&onload=on_captcha_loaded` 加载。 [已验证]
- 逻辑：`CreateCaptcha()` 在 `captcha_enabled` 为真时返回 `Recaptcha2`，否则返回 `NullCaptcha`——即**按请求/风控条件触发**。 [已验证]
- 结论：登录页的账号级人机校验是 **Google reCAPTCHA v2**（recaptcha.net 域名）；没找到 hCaptcha / Cloudflare Turnstile 的证据。Cloudflare 另有独立的 WAF 拦截层（见 §4.1），二者叠加。 [已验证/部分推断]

### 1.4 可长期复用的会话凭据：`_simpleauth_sess`

本机匿名请求实测到的 Set-Cookie（原始）：

```
csrf_cookie=<token>-1-<unix_ts>; Domain=.humblebundle.com; Expires=<+180天>; Max-Age=15552000; Secure; Path=/
_simpleauth_sess=<base64>|<unix_ts>|<40-hex>; Domain=.humblebundle.com; Expires=<+90天>; Secure; HttpOnly; Path=/; SameSite=None
```

- `_simpleauth_sess` 结构：`base64(JSON)|unix时间戳|40位十六进制`。匿名时 payload 解码为 `{"id":"<10位>"}`；`galaxy-integration` 的 `_decode_user_id()` 按 `split('|')[0]` base64 解码并取 `user_id` 字段，说明**登录后 payload 内含 `user_id`**。 [已验证：cookie 原文 + galaxy 源码]
- 中间的时间戳就是**签发时刻**（实测与请求时刻秒级一致），不是过期时刻。
- **匿名** `_simpleauth_sess` 的 `Expires` 实测为 **+90 天**（2026-09-26 → 2026-12-25）。`csrf_cookie` 为 **+180 天** 且**没有 HttpOnly**（因此同源 JS 能读它并放进 CSRF 头）。 [已验证]
- **登录态** `_simpleauth_sess` 的寿命本机无法实测（不能登录）。证据：
  - `MestreLion` 用 `int(cookie.split('|')[1]) + 730*24*3600` 推算 cookie 有效期（即假定 ~2 年），但这只是客户端本地 cookiejar 的过期值，不等于服务端签发寿命。 [推断]
  - `gfargo/humble-bundle-keys`：保存 Playwright `storage_state`（cookies + localStorage）"reused headlessly **until it expires**"，检测到 `/home/keys` 被重定向到 `/login` 就重新登录。 [已验证：源码；寿命数值未给出]
  - `smbl64/humble-cli` 的 `AGENTS.md`/docs 与 `BatteredBunny/humblebundle-games` 都直接把单个 `_simpleauth_sess` 当成长期 token 用（后者甚至直接从 Firefox `cookies.sqlite` 里读）。 [已验证]
- 结论：**会话凭据可长期复用（至少数十天量级），是唯一实质凭据；`_simpleauth_sess` 一旦过期/被吊销，只能重新走浏览器登录（且可能触发 2FA / Guard / reCAPTCHA）。** 具体数值寿命：开放问题（见 §6）。

---

## 2. 数据接口清单（逐个实测）

### 2.1 未登录实测结果（GET，2026-09-26）

| 端点 | 方法 | 未登录实测 | 说明 |
|---|---|---|---|
| `/api/v1/user/order` | GET | **401** + HTML `Unauthorized` | 订单 gamekey 列表；需会话 |
| `/api/v1/user/order?ajax=true` | GET | **401** | 同上（`?ajax=true` 变体，旧工具常用） |
| `/api/v1/orders` | GET | **200 `{}`** | 批量订单详情；未登录返回空 map，**不报 401** |
| `/api/v1/orders?all_tpkds=true` | GET | **200 `{}`** | 同上 |
| `/api/v1/order/<key>` | GET | **404**（0 字节） | 单订单详情；`?ajax=true` 亦 404 |
| `/api/v1/order/<key>?all_tpkds=true` | GET | **404**（0 字节） | 无效 key 即 404，空 body |
| `/api/v1/user/download/sign` | GET | **405 Method Not Allowed** | POST 专用（签名下载 URL） |
| `/api/v1/user/charity` | GET | **405** | POST 专用 |
| `/api/v1/tax_rate` | GET | **200** `{ "tax_type":"sales_tax", "tax_rate":0.0 }` | 公开 |
| `/api/v1/subscriptions/humble_monthly/subscription_products_with_gamekeys/` | GET | **302 → /login?goto=...** | 真实存在且需登录 |
| `/api/v1/subscriptions/humble_monthly/history?from_product=x` | GET | **404** | galaxy 用过的路径，**当前已不存在** |
| `/api/v1/trove/chunk?...` | GET | **404** | 旧 Trove 分块接口，**已废弃** |
| `/client/catalog?index=0..N` | GET | **200** JSON | **Trove 目录，公开可读**（见 §2.4） |
| `/humbler/redeemkey` | GET/POST | **403 Cloudflare** | 揭示端点；非浏览器被 WAF 拦 |
| `/humbler/choosecontent` | GET/POST | **403 Cloudflare** / **405** | Choice 选择端点 |
| `/humbler/redeemdownload` | GET | **405** | POST 专用，存在 |
| `/processlogin` | GET/POST | **403 Cloudflare** | 登录端点，被 WAF 拦 |
| `/home/keys` `/home/library` | GET | **302 → /login?goto=…&qs=reason%3DsecureArea** | 需要登录 |
| `/membership/home` | GET | **302 → /login** | Choice 个人主页需登录 |
| `/membership/<slug>`（如 `march-2026`） | GET | **200**（含公开 JSON） | 月度页公开部分（见 §2.3） |
| `/membership` | GET | 200 | 公开营销页 |
| `/monthly/p/august_2019_monthly` | GET | 200（含 `webpack-monthly-product-data`） | 旧 Monthly 页仍可访问 |
| `/monthly/trove` | GET | **301** | 重定向（Trove 归并到 membership） |
| `/trove` | GET | 200 → `/membership` | 同上 |

> 未观察到任何 `429` 或 `Retry-After`/ratelimit 响应头。对 `/api/v1/orders` 连续 30 次快速 GET 全部 200。 [已验证]

### 2.2 需要会话的私有 JSON 接口（来自真实客户端源码，形状一致）

1. **订单 gamekey 列表**
   - `GET https://www.humblebundle.com/api/v1/user/order`，头 `Cookie: _simpleauth_sess=<token>`，`Accept: application/json`
   - 返回：`[{"gamekey": "…"}, …]`
   - 来源：`smbl64/humble-cli` `internal/api/humble.go`；`gfargo` `api.py`；`UncleGoogle/galaxy` `_ORDER_LIST_URL`；`FailSpy` `HUMBLE_ORDERS_API`。 [已验证：多份源码]

2. **单订单详情（含 key）**
   - `GET https://www.humblebundle.com/api/v1/order/<gamekey>?all_tpkds=true`
   - 返回单个 order 对象；关键字段：
     - 根：`gamekey`、`uid`、`created`、`claimed`、`choices_remaining`
     - `product.{machine_name,human_name,category,choice_url,is_subs_v3_product}`
     - `subproducts[]`（含 `downloads[]`，即 DRM-free 文件/书籍）
     - `tpkd_dict.all_tpks[]`：**真正放 key 的地方**，字段含 `machine_name`（=keytype）、`human_name`、`key_type`/`key_type_human_name`、`keyindex`、`redeemed_key_val`（key 值或 null）、`is_expired`、`expiry_date`/`expiration_date`/`num_days_until_expired`、`steam_app_id`、`sold_out`、`direct_redeem`、`exclusive_countries`/`disallowed_countries`、`custom_instructions_html`、`gamekey`
   - 来源：`smbl64`；`gfargo` `api.py`（明确列出字段）；`MrMarble/hb-key-exporter` `util.ts` 的 `Order` 类型；`smbl64` issue #189。 [已验证：多份源码]

3. **批量订单详情（一次多单）**
   - `GET https://www.humblebundle.com/api/v1/orders?all_tpkds=true&gamekeys=<k1>&gamekeys=<k2>…`
   - 返回 `{ "<gamekey>": Order, … }`（map）
   - 分块约定：`smbl64` 按 10 个 gamekey 一批并发；`BatteredBunny` 一次传全部。
   - 来源：`smbl64` `apiBundlesURL`；`BatteredBunny/humblebundle-games` `src/api.rs`；`galaxy` `_ORDERS_BULK_URL`。 [已验证：源码]

4. **Humble Choice 月度数据**
   - HTML：`GET https://www.humblebundle.com/membership/<slug>`（slug 如 `march-2026`、`august_2019_monthly`；旧式 Monthly 也接受 `https://www.humblebundle.com/monthly/p/<slug>`）
   - 内嵌 JSON：`<script id="webpack-monthly-product-data" type="application/json">…</script>`；旧页面还可能有 `<script id="webpack-subscriber-hub-data">`
   - 结构：`contentChoiceOptions.{usesChoices, productIsChoiceless, contentChoiceData.game_data.<short>.tpkds[]}`；旧式有 `contentChoiceData.<id>.content_choices`
   - 来源：`smbl64` `ReadBundleChoices()`；`BatteredBunny` `month.rs`；`FailSpy` `get_month_data()`（"No real API for this, seems to just be served on the webpage"）；`galaxy` `get_choice_content_data()`。 [已验证：源码]
   - 订阅商品接口：`GET /api/v1/subscriptions/humble_monthly/subscription_products_with_gamekeys`（实测需登录 302）。 [已验证]

5. **签名下载 URL（DRM-free / Trove / 书籍）**
   - `POST https://www.humblebundle.com/api/v1/user/download/sign`，params `{machine_name, filename}` → 返回 `{signed_url, signed_torrent_url}`；下载 CDN 为 `https://dl.humble.com/<file>`。
   - `POST https://www.humblebundle.com/humbler/redeemdownload`（`galaxy`：`{download, download_page:false, download_url_file}`）
   - 来源：`xtream1101/humblebundle-downloader` `_get_trove_download_url`；`galaxy` `webservice.py`；`luckydonald` `constants.py`。 [已验证：源码]

6. **Trove 目录：公开**
   - `GET https://www.humblebundle.com/client/catalog?index=<n>` → JSON 数组，每页 20 条；`index=0..2` 各 20 条，`index=3` 6 条，之后空。实测共 66 条。
   - 字段：`machine_name`（如 `20001aspacefelony_trove`）、`human-name`、`downloads.{windows,macos,linux}`（含 `url.web`/`url.bittorrent`、`signature_file`、`md5`、`file_size`）、`date-added`、`date-ended`（`32503680000` ≈ 公元 3000 年 = 哨兵值「无到期」）、`trove_category`、`all-access`。
   - 即：**Trove 目录元数据无需登录即可全量读取；真正下载文件需要登录换取签名 URL。** [已验证：本机实测]

### 2.3 公开 vs 私有的边界（Choice 页实测）

`GET /membership/march-2026`（未登录）返回 200、~608KB，内嵌 `webpack-monthly-product-data` JSON 132KB，**包含每款游戏的 `tpkds[]` 元数据**：`machine_name`、`key_type`、`steam_app_id`、`expiration_date|datetime`、`num_days_until_expired`、`exclusive_countries`/`disallowed_countries`、`sold_out`、`custom_instructions_html` 等。但**不含** `redeemed_key_val`、`keyindex`，且 `gamekey: null`——这些是每用户字段。 [已验证：本机实测]

> 也就是说：**「有哪些游戏、什么平台、是否锁区、何时过期」是公开情报；「这个 key 是否已分配、key 值是什么、keyindex 是多少」必须登录且必须揭示。** 这正好界定了 reveal 的价值与必要边界。

### 2.4 Trove / 书籍 / 软件包的数据落点

- **书籍/漫画/有声书**：与游戏同一套 order JSON。`subproducts[].downloads[].platform` 会出现 `ebook` 等值；`DMarby/humblebundle-ebook-downloader` 就是拉 `/api/v1/user/order?ajax=true` + `/api/v1/order/<gamekey>?ajax=true`，再按 `platform == 'ebook'` 过滤。此类包通常**没有 Steam key**。 [已验证：源码]
- **软件包（softwarebundle）**：`machine_name` 以 `_softwarebundle` 结尾（如 `mixcraft8homestudio_…_softwarebundle`、`voltagemodularignite_…`）。揭示不会有 key——厂商流程不同。`gfargo` 把 `softwarebundle`/`voucher`/`keyless`/`freegame` 一起预跳过。 [已验证：issue #4 原文 + 源码]
- **Trove**：目录见 `GET /client/catalog`（公开）；下载需 `POST /api/v1/user/download/sign`。旧 `url_trove = /monthly/trove` 与 `/api/v1/trove/chunk` 已 301/404。 [已验证]

---

## 3. 「揭示 key」的请求形态

### 3.1 端点与 body（多份真实实现互证）

```
POST https://www.humblebundle.com/humbler/redeemkey
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Accept: application/json, text/javascript, */*; q=0.01
X-Requested-With: XMLHttpRequest
CSRF-Prevention-Token: <csrf_cookie 的值>          # 部分实现发；见 §4.2
Referer: https://www.humblebundle.com/home/keys
Cookie: _simpleauth_sess=<token>

keytype=<tpk.machine_name>&key=<order.gamekey>&keyindex=<tpk.keyindex>[&gift=true]
```

- `MrMarble/hb-key-exporter`（2026-09-22，TypeScript userscript）：`fetch('/humbler/redeemkey', {credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'}, body:{keytype, key: category_id(=order.gamekey), keyindex}, method:'POST'})`；gift 时加 `gift=true`。**未发任何 CSRF 头**（同源 fetch 自带 cookie）。 [已验证：源码]
- `gfargo/humble-bundle-keys`（2026-05）：在真实页面里 `page.evaluate(fetch(...))`，头含 `content-type` + `accept` + `x-requested-with` + `CSRF-Prevention-Token: <csrf_cookie>`。 [已验证：源码]
- `FailSpy`（2024）：Selenium，头 `csrf-prevention-token: <csrf_cookie>`，body `{keytype, key: tpk.gamekey, keyindex}`。 [已验证：源码]
- `smbl64` issue #190 的**最小可用 curl**（用户实测给出）：只带 cookie + 通用 UA + `--data-raw "keytype=…&key=…&keyindex=0"`，**完全没有 CSRF token**；并注明 "The generic user-agent is required. Sometimes this fails due to Cloudflare anti-bot measures, but it usually works when retried." [已验证：issue 原文]

### 3.2 响应

- 成功形态（不同版本/不同 keytype 见过多种）：`{"success": true, "key": "XXXXX-XXXXX-XXXXX"}`；也可能是 `redeemed_key_val` 或 `key_val`；也可能 2xx 但**不回带 key**（此时需重新 GET 该订单，读 `redeemed_key_val`）。
- 失败：`{"success": false, "error_msg": "...", "redeem_retryable": <bool>}`；`redeem_retryable === false` 表示不必重试。key 池耗尽时会报 "no more keys available at this time"。
- 来源：`gfargo` `api.py::_reveal`（明确列出 3 种成功字段与 silent-no-key 回退）；`MrMarble` `RedeemResponse`（`success/error_msg/error/redeem_retryable/giftkey/key`）。 [已验证：源码]

### 3.3 CSRF token 从哪来（两个 token）

| token | 载体 | 来源 | 用途 |
|---|---|---|---|
| `_le_csrf_token` | 表单字段 | HTML `<input name="_le_csrf_token">`，或 page-data `csrfTokenInput` / `csrfFormKey` | 传统表单 POST（`/processlogin`、2022 年的 humbleguard） |
| `csrf_cookie` | cookie（**HttpOnly 关闭**，JS 可读） | `Set-Cookie: csrf_cookie=…`（+180 天） | AJAX 请求头 `csrf-prevention-token` / `CSRF-Prevention-Token` |

- 实测 page-data：`"csrfTokenInput": "<input type=\"hidden\" class=\"csrftoken\" name=\"_le_csrf_token\" value=\"XTwPPoD_ZI_-rg2F-1-1790394121\">"`, `"csrfFormKey": "_le_csrf_token"`。 [已验证]
- 注意二者值不同、且 `csrf_cookie` 值形如 `<base64ish>-1-<unix_ts>`（与本机实测一致）。 [已验证]

### 3.4 频控表现

- **未发现明确的 API 级速率限制**（无 429、无 ratelimit 头）。 [已验证：本机 30 次快速 GET 全 200]
- **真实频控表现为 Cloudflare WAF 的随机 403**：`gfargo` 在 195 单的一次运行里出现 1 次瞬时 403（≈0.5%），处理方式是**指数退避重试 2 次**。 [已验证：issue #1/#2 + CHANGELOG 0.5.0]
- 第三方普遍主动限速：`gfargo` reveal 间隔 `polite_delay_ms=800`、Choice 间隔 `polite_delay_s=3.0`（"matches observed UI lag of 3–10 s"）；`--max-claims` 默认 100。 [已验证：源码]

---

## 4. 边界：Cloudflare / CSRF / ToS / robots.txt / 副作用

### 4.1 Cloudflare（**最重要的技术边界**）

- 本机实测：
  - `GET /api/v1/user/order` → 200/401（**无** CF 拦截）
  - `POST /humbler/redeemkey`（任意头组合，含 Origin/Referer/X-Requested-With/csrf 头/`__cf_bm`）→ **403**，body 是 Cloudflare `Sorry, you have been blocked` WAF 页（`<title>Attention Required! | Cloudflare`），**不是可解的 JS challenge**。 [已验证]
  - `GET /humbler/redeemkey`、`GET /humbler/choosecontent`、`GET/POST /processlogin` 同样 403。 [已验证]
- 归因（第三方源码给出的机理解释）：Cloudflare 对 **HTTP/2 + TLS 指纹**做识别；Playwright 的 `APIRequestContext` 指纹不像真 Chrome，于是对**状态变更 POST** 返回 403；**GET 不受影响**。解法是"把 POST 走真实浏览器的 `page.evaluate(fetch)`，让 CF 看到同源真 Chrome 请求"。 [已验证：`_browser_fetch.py` 文档串]
- 量化证据：`gfargo` CHANGELOG 0.2.5 —— **`--headless` 一次运行得到 0 个 reveal + 167 个 CF 403；`--no-headless` 得到 144 个 reveal + 2 个错误。** 即**连 headless Chromium 也会被 CF 拒**，必须可见/真实渲染的浏览器上下文。 [已验证]
- `smbl64` issue #190 与 `FailSpy` issue #1 都记录过 "Sometimes this fails due to Cloudflare … usually works when retried"。 [已验证]

> **设计含义**：任何"纯 requests/curl/无头 API 客户端"方案在 reveal 面上会整体失败；必须内嵌一个真实浏览器上下文专责 POST 与登录，并且对 403 做退避重试。这与本项目"内嵌 Pi coding agent 做页面级决策"的方向一致——浏览器是能力载体，不是可选优化。

### 4.2 CSRF 是"软校验"

- `gfargo` CHANGELOG 0.2.2："Without `X-Requested-With`, Humble's backend appears to reject the call (acts as a soft anti-CSRF check)." 即 `X-Requested-With: XMLHttpRequest` 更像必需项，而 `csrf-prevention-token` 头在多数实现里被发送，但 `smbl64` 用户实测的最小 curl 不含它也能工作。 [已验证：原文；严格必要性未 100% 确认 → 见 §6]

### 4.3 ToS 原文（自动化相关条款）

ToS 页面：`https://www.humblebundle.com/terms`（正文由 Ziff Davis 运营）。关键条款（原文逐字）：

> **(b) Restrictions.** You agree not to engage in any of the following prohibited activities: **(i)** copying, distributing, or disclosing any part of the Service in any medium, including without limitation by any automated or non-automated "scraping"; **(ii)** using any automated system, including without limitation "robots," "spiders," "offline readers," etc., to access the Service in a manner that sends more request messages to the Company servers than a human can reasonably produce in the same period of time by using a conventional on-line web browser (except that Humble Bundle grants the operators of public search engines revocable permission …); **(iii)** transmitting spam …; **(iv)** attempting to interfere with, compromise the system integrity or security or decipher any transmissions …; **(v)** taking any action that imposes, or may impose in our sole judgment an unreasonable or disproportionately large load on our infrastructure; **(vi)** uploading invalid data, viruses …; **(vii)** collecting or harvesting any personally identifiable information …; **(viii)** using the Service for any commercial solicitation purposes; **(ix)** impersonating another person …; **(x)** interfering with the proper working of the Service; **(xi)** accessing any content on the Service through any technology or means other than those provided or authorized by the Service; **(xii)** bypassing the measures we may use to prevent or restrict access to the Service …; **(xiii)** sell, assign, rent, lease, act as a service bureau, or grant rights in the Products …

封号条款（原文逐字）：

> **(c) Termination of Service or Access.** We may, without prior notice and at our sole discretion, change the Service; … **create usage limits for the Service**, including, without limitation, limiting the number of Products you may purchase …; **We may permanently or temporarily terminate or suspend your account, for any reason at any time upon our sole discretion, without any notice and liability**, if you … **violate any provision of this Agreement**; commit or are suspected of committing user fraud; resell or are suspected of reselling an account for profit … **We may at our sole discretion re-instate a suspended account.**

另有一条与"资产管家"正相关的：

> **(j) No Ongoing Obligations.** … Humble Bundle and its licensors reserve the right, without liability to you, **to change, suspend, remove, or disable access to any Products**, content, or other materials … at any time without notice.
> 以及：keys 必须在购买后 **3 年内**兑换，逾期未兑换 Humble 无义务再提供（含 Alternate Keys）。

解读：**条款并不禁止"使用自己的账号消费自己的已购资产"，但它同时禁止 (a) 抓取内容、(b) 超出人类频率的自动化访问、(c) 绕过访问控制措施（§xii），并保留 (d) 随时封号。** 因此一个"自动揭示自己 key"的工具落在灰区：(a)(b) 可通过对齐人类节奏、只读自己数据来规避，(c) 则与"必须绕过 Cloudflare 才能 POST"存在张力——但注意 Cloudflare 拦的是**指纹不像浏览器的客户端**，用真实浏览器即"走官方提供的通道"，通常被解释为合规。这是**法律/条款判断，不是技术判断**，需由项目方决策。 [已验证：ToS 原文；解读为分析]

### 4.4 `robots.txt` 原文（Ziff Davis）

`https://www.humblebundle.com/robots.txt`（2026-09-26 抓取，逐字）：

```
# Ziff Davis content is made available for your non-commercial use subject to our 
# Terms of Use here: https://www.humblebundle.com/terms
# Use of any robot, crawler, or other tool to scrape, harvest, extract, or retrieve any content on
# this website using automated means is prohibited without written permission from Ziff Davis.
# Prohibited uses include but are not limited to:
# (1) text and data mining under Art. 4 of the EU Directive on Copyright in the Digital Single
# Market;
# (2) development or operation of artificial intelligence or machine learning software or
# databases, including by training, fine-tuning, embedding, and retrieval-augmented generation;
# (3) creating data sets containing our content or sharing it with others; and
# (4) any commercial purposes.
# Contact licensing@ziffdavis.com for assistance.

User-Agent: *
Sitemap: https://www.humblebundle.com/sitemap.xml

Disallow: /?key*
Disallow: /?s=thanks
Disallow: /emailhelper
Disallow: /delete-key
Disallow: /download-lister
Disallow: /store/product/*
Disallow: /user/associate
Disallow: /user/signup-complete
Disallow: /widget/v2/*
Disallow: /return-paypal
Disallow: /return-billing-agreement-paypal
Disallow: /return/
Disallow: /*_escaped_fragment_=system-requirements
```

要点：[已验证]
- 注释层**明文禁止** "any robot, crawler, or other tool to scrape, harvest, extract, or retrieve any content … using automated means"，并点名禁止 **AI/ML 训练、微调、embedding、RAG**（(2)）和数据集构建（(3)）。
- `Disallow` 列表**刻意不包含** `/api/*` 与 `/humbler/*`——即这些私有接口未在 robots 层声明（但 ToS 与 CF 仍适用）。
- 注意 `Disallow: /?key*` 与 `Disallow: /delete-key`、`/download-lister` 等。

### 4.5 reveal 的副作用（容易被忽视的边界）

- **`*_keyless`**（`epic_keyless`、`gog_keyless`、`uplay_keyless`、`*_keyless`）揭示时会**直接把游戏发放到该用户已绑定的对应商店账号**；若未绑定则报错。用户原文：
  > Keep in mind that keys with a key_type of `epic_keyless`, `gog_keyless`, `uplay_keyless`, or just `*_keyless` will redeem to the respective user's account (if linked) or error (if not linked) when revealing, which may be unintended if they just wanted to reveal all of their keys … [已验证：smbl64 issue #190]
- **揭示即 claim**：`gfargo` `scraper.py`："a 'Redeem' button that reveals **and** marks the key as claimed in Humble's system"。因此不能把 reveal 当"预览"，它会消耗/占用。
- **key 池耗尽/锁区/追溯过期**：`sold_out`、`exclusive_countries`/`disallowed_countries`、`is_expired`/`expiration_date` 都在 order JSON 里。社区维护的问题库 `AlexanderTheGrey/humble-bundle-redemption-issues`（70 stars，2026-02-22）记录了大规模"不发 key、key 池耗尽、Steam key 被静默换成别的 DRM、追溯加过期"的案例，并给出官方导出路径：`https://dsar.humblebundle.com`（数据主体访问请求，可拿到**已揭示**的 `redemptions-1.csv`）。 [已验证：README 原文]
- **Choice 有「选择」语义**：现代 Choice 多为 `productIsChoiceless: true` 直接发全部；旧式是 "pick N of M"，未选的游戏**根本不会出现在 order JSON 的 tpk 里**，必须去 `/membership/<slug>` 页面点选（浏览器驱动）。 [已验证：`gfargo` browser_choice.py 文档 + 实测 `productIsChoiceless`]

---

## 5. 已知第三方工具现状

### 5.1 端点/行为对照表

| 项目 | stars | 最近 push | 语言 | 用到的 Humble 端点 | 现状/备注 |
|---|---|---|---|---|---|
| `smbl64/humble-cli` | 142 | 2026-09-19 | Go | `/api/v1/user/order`、`/api/v1/orders?all_tpkds=true`、`/api/v1/order/<k>?all_tpkds=true`、`/membership/<when>` + `#webpack-*` | 活跃；只做列举/下载/搜索，**不含 reveal**（issue #190 曾请求，未采纳）。文档教用户手抄 `_simpleauth_sess` |
| `MrMarble/hb-key-exporter` | 19 | 2026-09-22 | TypeScript (userscript) | `POST /humbler/redeemkey`；订单数据从 `localStorage` 的 `v2\|*`（LZString 压缩）读取 | 活跃；运行在 `/home/keys*`，靠**同源浏览器**绕过 CF；含批量揭示 + gift link + CSV/ASF/TXT 导出 |
| `gfargo/humble-bundle-keys` | 1 | 2026-05-05 | Python (Playwright) | `/api/v1/user/order`、`/api/v1/order/<k>?all_tpkds=true`、`POST /humbler/redeemkey`、`POST /humbler/choosecontent`、`/membership/<slug>` DOM | **最新、最完整、踩坑记录最全**；必须 `--no-headless` 才能 reveal；含诊断子命令与 sanitized fixtures |
| `FailSpy/humble-steam-key-redeemer` | 166 | 2024-02-27 | Python (Selenium) | `/processlogin`、`/humbler/redeemkey`、`/api/v1/user/order`、`/api/v1/order/`、`/api/v1/subscriptions/humble_monthly/subscription_products_with_gamekeys/`、`/humbler/choosecontent`、`/subscription/payearly` | 半废弃（2.5 年未更新）；登录/2FA/Guard/CSRF 逻辑写得最清楚，可作**协议参考**；依赖 geckodriver |
| `MestreLion/humblebundle` | 221 | 2022-07-31 | Python | `/login`、`/processlogin`、`/user/humbleguard`、`/home/keys`（正则抓 `gamekeys=[...]`）、`/api/v1/order/<k>` | 停更（4 年+）；`/user/humbleguard` 路径形态已过时；**只列不下 key 值**（key 值来自 reveal，它不做） |
| `javierjulio/humble-bundle-key-exporter` | 22 | 2026-09-01 | JS bookmarklet | 纯 DOM 抓 `/home/keys` 分页 `.unredeemed-keys-table` | 活跃；**只导出未揭示条目的元信息**（名/platform/bundle），不揭示 key |
| `BatteredBunny/humblebundle-games` | 2 | 2026-09-22 | Rust | `/api/v1/orders?all_tpkds=true&gamekeys=…`、`/membership/<choice_url>` | 很新；**从 Firefox `cookies.sqlite` 直接读 `_simpleauth_sess`**，零登录流程；只展示未领取 key，不 reveal |
| `xtream1101/humblebundle-downloader` | 611 | 2024-08-05 | Python | `/api/v1/order/<k>?all_tpkds=true`、`/api/v1/user/download/sign`、`/client/catalog?index=N`、`/play/asmjs/…` | **已 archived**；Trove 目录接口的权威来源 |
| `DMarby/humblebundle-ebook-downloader` | 240 | 2024-04-30 | JS | `/login?goto=%2Fhome%2Flibrary`、`/api/v1/user/order?ajax=true`、`/api/v1/order/<k>?ajax=true` | 停更；书籍过滤 `platform=='ebook'`；用 `?ajax=true` 变体 |
| `UncleGoogle/galaxy-integration-humblebundle` | 190 | 2024-05-13 | Python | 见 §2.2（含 `subscription_products_with_gamekeys`、`history?from_product=`、`user/download/sign`、`humbler/redeemdownload`、`monthly/p/<slug>`） | 半活跃；`history` 端点**现已 404**；`_decode_user_id` 揭示 cookie 结构 |
| `luckydonald/humblebundle_trove_downloader` | 11 | 2020-11-27 | Python | `/monthly/trove`、`/api/v1/user/download/sign`、`/api/v1/trove/chunk?…`、`dl.humble.com` | **废弃**；其 trove chunk 接口实测 404 |
| `BeevMan/HumbleBundle-Keys-Clipboard` | 9 | 2025-03-18 | JS 扩展 | keys 页 DOM | 剪贴板辅助；不 reveal |
| `yourcodekitten/bendobundles` | 0 | 2026-09-25 | Rust | gift link 相关 | 极新、私有场景（给朋友发 gift link），可作 gift 流程参考 |
| `gbzret4d/game-store-enhancer` | 7 | 2026-09-26 | JS userscript | keys 页 DOM | 当天仍在更新；给 Humble 库条目补 Steam 链接，不 reveal |
| `AlexanderTheGrey/humble-bundle-redemption-issues` | 70 | 2026-02-22 | — | 用官方 `dsar.humblebundle.com` 导出 | 不是工具，是"key 交付失败/锁区/追溯过期"的社区事实库 |

> star/日期来自 `gh api repos/<r>`，2026-09-26 采集。 [已验证]

### 5.2 各工具踩过的坑（按证据）

1. **Cloudflare 403（最普遍）**
   - `gfargo`：headless 全灭（0/167），headed 恢复；单次瞬时 403 需退避重试。 [issue #1/#2, CHANGELOG 0.2.4/0.2.5]
   - `smbl64` #190、`FailSpy` #1 同样记录。
2. **Cookie 失效 / 格式陷阱**
   - `smbl64` #62：用户把 `_simpleauth_sess` 里三个 `|` 段拆错 / 被 shell/powershell 当管道；正确做法是整串原样使用。 [已验证]
   - 多个工具因此提供"从浏览器 Cookie 数据库直接读"或"注入单个 cookie"的路径。 [已验证]
3. **端点变更**
   - `/api/v1/trove/chunk`（旧 Trove）→ 404；`/monthly/trove` → 301；`/api/v1/subscriptions/humble_monthly/history` → 404；`GET /user/humbleguard` → 404。 [已验证：本机实测]
   - `smbl64` #137："error decoding response body"（API 形状变化导致反序列化失败）。 [已验证]
4. **DOM selector 漂移**
   - `gfargo` 明确为 keys 页/会员页维护"多重 fallback selector"，并提供 `diagnose` 子命令导出脱敏快照；CHANGELOG 0.3.1–0.3.4 记录多轮修 selector、修 `.js-keyfield.keyfield.enabled`（是 `div` 不是 `button`）、修"点击 backdrop 关闭 modal"等。 [已验证]
5. **reveal 语义/字段坑**
   - `gfargo` 0.2.1：字段名是 `keyindex`（一个词）不是 `key_index`；读错导致"0 revealed, 167 errors"。 [已验证]
   - 2xx 但无 key（silent-no-key）→ 通常意味着是 Choice 内容，需要走两步 `choosecontent` + `redeemkey`。 [已验证]
6. **key 池/过期/锁区**
   - key 池可能耗尽（"no more keys available"），需单独分类上报；`sold_out`/`is_expired`/`exclusive_countries` 在 order JSON 里可预读。 [已验证]
   - `gfargo` 0.3.4：`.expired` keyfield（IGN Plus、Boot.dev 试用）点击无效，需预跳过。 [已验证]
7. **登录态持久化**
   - 成功范式：真实浏览器首次登录 → 保存 `storage_state`(cookies+localStorage) 或仅 `_simpleauth_sess` → 之后复用；用 `/home/keys` 是否重定向到 `/login` 作为有效性探针。 [已验证：`gfargo` auth.py]

---

## 6. 未能验证 / 开放问题

1. **登录态 `_simpleauth_sess` 的真实服务端寿命**：未登录无法实测。已确认匿名 cookie 为 +90 天；登录态未验证（`MestreLion` 假定 +730 天仅为客户端本地 cookiejar 值，非服务端承诺）。**开放**。
2. **服务端是否会因自动化而吊销会话/封号**：未找到可公开复现的封号案例（GitHub issue 检索未见明确"因 reveal 自动化被封"。`FailSpy` issue、`galaxy` #154 都是登录/CF 问题，不是封号）。**ToS 明文保留封号权，但执行证据缺失**——诚实标注为"未观察到，但条款允许"。
3. **`csrf-prevention-token` / `X-Requested-With` 的严格必要性**：多份实现都发，但 `smbl64` #190 的最小 curl 不含 CSRF 也声称可用；由于 POST 在我方 IP 被 CF 硬拦，无法本机对照实验。**开放**。
4. **`/api/v1/user/order` 与 `/api/v1/orders` 的语义差异**：前者未登录 401、后者 200 `{}`；是否 `/api/v1/orders` 是"新版无鉴权壳 + 空结果"还是"需要 gamekeys 参数"，未确证。**开放**。
5. **`freegame`（Humble Store 免费游戏赠送）的揭示端点**：`gfargo` issue #5 明确"从未逆向成功，怀疑在 `/store/` 下"。**未验证**。
6. **`softwarebundle`/`voucher` 的厂商流程**：只知道 `/humbler/redeemkey` 不会给 key，具体厂商兑换流程**未逆向**。
7. **Choice 的 `parent_identifier` 取值**：`gfargo` 只观察到 `"initial"`，旧式/其他语言站点是否不同**未验证**。
8. **`expiry_date` vs `expiration_date` vs `num_days_until_expired` 的权威字段**：`smbl64` #189 指出 API 同时返回多个、规则不一致，且有 key 的过期只写在 `custom_instructions_html` 里（需正则）。**未验证**（需登录态样本）。
9. **hCaptcha**：登录页未发现 hCaptcha/Turnstile；但不能排除某些风控路径动态引入。**未证实存在**。
10. **官方 API**：`api.humblebundle.com` 不解析（HTTP 000）；`/developer` 页面存在但未确认与用户库 API 有关。Humble **无面向消费者的公开 API**（`gfargo` 亦如此声明）。**已验证"无公开 API"**。

---

## 7. 对本项目（游戏资产管家）的直接含义

- **架构上必须内嵌真实浏览器上下文**（可见或至少真实渲染的 Chromium/Firefox），承担：① 首次登录 + 2FA/Guard/reCAPTCHA；② 所有 `POST /humbler/*` 揭示动作。纯 HTTP 客户端只能做只读。
- **会话复用**：持久化 `_simpleauth_sess`（+ 可选 storage_state）到加密存储；用「访问 `/home/keys` 是否被重定向到 `/login`」做有效性探针；失效时回退到浏览器登录。
- **数据读取优先走 GET JSON**（稳、便宜、无 CF）：`/api/v1/user/order` → `/api/v1/orders?all_tpkds=true&gamekeys=…`（分块，≤10/批）→ `/membership/<slug>` 公开+登录态 JSON。
- **揭示动作要独立编排**：幂等（以 `redeemed_key_val` 判已揭示）、限速（≥800ms，Choice ≥3s）、对 403 指数退避、区分 `*_keyless`（会直接发放到绑定账号）与 `softwarebundle/voucher/freegame`（无 key，跳过）。
- **「揭示」= 领取，不可逆**：对 `*_keyless` 尤其要显式征求用户确认。
- **条款风险需显式提示**：robots.txt/ToS 禁自动化抓取与绕过访问控制；建议只处理"用户自己的账号与已购资产"、对齐人类节奏、不缓存他人数据、不做 AI 训练，并把这些写进产品文案与用户协议。是否可接受由项目方决策。

---

## 附 A. 关键证据命令

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

# robots.txt / ToS
curl -sL -A "$UA" https://www.humblebundle.com/robots.txt
curl -sL -A "$UA" https://www.humblebundle.com/terms

# 会话 cookie 结构
curl -s -A "$UA" -D - -o /dev/null https://www.humblebundle.com/ | grep -i '^set-cookie'

# 未登录端点探针
curl -s -A "$UA" -o /dev/null -w '%{http_code}\n' https://www.humblebundle.com/api/v1/user/order       # 401
curl -s -A "$UA" -o /dev/null -w '%{http_code}\n' https://www.humblebundle.com/api/v1/orders           # 200 {}
curl -s -A "$UA" -o /dev/null -w '%{http_code}\n' https://www.humblebundle.com/api/v1/user/download/sign # 405
curl -s -A "$UA" 'https://www.humblebundle.com/client/catalog?index=0' | head -c 300                   # 200 JSON

# 登录页内嵌 page-data（CSRF token 名）
curl -sL -A "$UA" https://www.humblebundle.com/login | grep -o '"csrfFormKey[^,]*'

# 登录/CF 拦截
curl -s -A "$UA" -X POST https://www.humblebundle.com/processlogin -o /dev/null -w '%{http_code}\n'   # 403 CF
curl -s -A "$UA" -X POST https://www.humblebundle.com/humbler/redeemkey -o /dev/null -w '%{http_code}\n' # 403 CF

# 公开 Choice 月度 JSON（含 tpkds 元数据，但无 key/keyindex）
curl -s -A "$UA" https://www.humblebundle.com/membership/march-2026 | grep -o 'webpack-monthly-product-data'

# 源码证据
curl -sL https://raw.githubusercontent.com/gfargo/humble-bundle-keys/main/humble_bundle_keys/api.py
curl -sL https://raw.githubusercontent.com/smbl64/humble-cli/HEAD/internal/api/humble.go
curl -sL https://raw.githubusercontent.com/MrMarble/hb-key-exporter/main/src/util.ts
curl -sL https://raw.githubusercontent.com/BatteredBunny/humblebundle-games/main/src/api.rs
```

## 附 B. 关键源码出处（可复核）

- reveal 端点与 body：`MrMarble/hb-key-exporter` `src/util.ts` `redeem()`；`gfargo/humble-bundle-keys` `humble_bundle_keys/api.py` `_reveal()`；`smbl64/humble-cli` issue #190 curl。
- Cloudflare 机理：`gfargo/humble-bundle-keys` `humble_bundle_keys/_browser_fetch.py` 文档串；`CHANGELOG.md` 0.2.4/0.2.5。
- 登录字段/2FA/Guard/reCAPTCHA：`https://cdn.humblebundle.com/static/hashed/0f74c8f4f1c85fe3bf57f12b58f92d1347d0aa49.js`；`FailSpy` `humblesteamkeysredeemer.py::humble_login()`。
- 订单/Choice/Trove 端点：`smbl64` `internal/api/humble.go`；`UncleGoogle/galaxy-integration-humblebundle` `src/webservice.py` + `src/consts.py`；`xtream1101/humblebundle-downloader` `download_library.py`；`luckydonald` `constants.py`；`BatteredBunny` `src/api.rs`/`src/month.rs`。
- keytype 分类与跳过：`gfargo` `humble_bundle_keys/choice.py::categorize_keytype()`；`humble_bundle_keys/api.py` `_SKIP_CATEGORIES`；issue #4/#5。
- `_simpleauth_sess` 结构：`UncleGoogle/galaxy-integration-humblebundle` `src/webservice.py::_decode_user_id()`；`BatteredBunny` `src/cookies.rs`。
