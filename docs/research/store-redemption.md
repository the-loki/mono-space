# 各商店 key 激活的官方接口能力与浏览器自动化需求

> 研究票据：the-loki/mono-space#3
> 验证日期（UTC）：2026-09-26
> 分支：`research/store-redemption`
> 目标形态：Linux 桌面应用「游戏资产管家」，内嵌 Pi coding agent 做页面级决策
> 本项目「资产」= 游戏开发资产（引擎素材包 / 3D / 音频等），**不是游戏本体**

---

## 0. 结论先行（TL;DR）

1. **Humble 的引擎资产包（Unreal）以「兑换码」交付，不是账号直连发资产。** 兑换后资产进入 Fab（Epic 的资产市场）的 My Library。
2. **Fab 没有自己的兑换页，也没有官方公开 API。** 官方唯一的兑换途径是 Epic 账号侧的网页 `https://www.epicgames.com/account/code-redemption`（302 到 `accounts.epicgames.com`），需要 **Epic Games 账号登录（OAuth 授权码流程）**。Fab 的 `fab.com/redeem` 稳定返回 404。
3. Fab 自身 Web 客户端有一个**内部、未公开文档的 JSON API**（`https://www.fab.com/i/...`，Django-REST 风格、cookie + `X-CsrfToken` 鉴权、Cloudflare 保护），但**没有 redeem 端点**，且 `fab.com` 上任何操作都要先过 Cloudflare 挑战 / hCaptcha。
4. **因此本项目的 key 激活在 Linux 上只能靠浏览器自动化（内嵌浏览器 + 复用 Epic 登录态），不存在可脱离浏览器的官方批量兑换接口。** 边界在于：登录（含 2FA）与人机校验必须由人/真实浏览器完成，之后「填码 → Redeem → Confirm → 校验 My Library」可以自动化。
5. **Linux 专属限制（官方原文）：「Fab in Launcher is only available on Windows and Mac.」** Epic 的安装包只提供 `.msi`/`.dmg`（`.deb`/`.rpm` 返回 404）。Linux 上获取 UE 格式资产的官方路径只剩：浏览器 fab.com 下载 + Unreal Engine 5.3+ 的 Fab 插件（UE 本身支持 Linux）。
6. Steam / GOG / EA App / Ubisoft Connect / Battle.net 兑换的是**游戏本体 license**，与开发资产无关，已压缩到 §3.0「为何不适用」。

---

## 1. 交付形态实证：Humble → Fab 是「兑换码」

**已验证。**

Humble 官方帮助中心文章 *FAB Keys - Redemption Instructions*（id `53302161018651`，最后更新 `2026-09-22`）原文步骤 `[S1]`：

1. Log in to your account at Fab.com.
2. Click on your profile icon in the top right corner and select **'Redeem Code'**.
3. Enter your **unique key** and click 'Redeem'.
4. The product will be **instantly added to your library** for use in Unreal Engine.
5. Activate your key on Fab.com (**Profile > Redeem Code**).
6. Open the **Epic Games Launcher** and navigate to your **vault** → 'Add to Project' → 选择 UE 工程。

结论：

- 交付形态 = **一次性 key / 兑换码**（account-bound，兑换后绑定到 Epic 账号），不是「账号直连发资产」。
- 唯一的「非码」直授路径是 Quixel 组织直授：Epic 官方文档说明组织成员被加入后 Megascans 会直接进入 Fab library，「without going through the regular purchase flow」`[S2]`——但这是 Quixel 企业/组织场景，与 Humble 资产包无关。
- UE 格式资产兑换后**仍然需要 Epic Games Launcher 的 Fab Library（旧称 Vault）或 UE 的 Fab 插件**才能进入工程（见 §6 的 Linux 影响）。

> 验证方式：`curl -s "https://support.humblebundle.com/api/v2/help_center/en-us/articles/53302161018651.json"`（Zendesk 公开 API，无需登录）。

---

## 2. 兑换流程与入口（精确链路）

### 2.1 官方文档定义的流程（已验证）

Epic 官方 Fab 文档 *Purchasing and Downloading Assets in Fab* 的 **Product Keys** 小节 `[S2]` 原文：

> You can use product keys, called codes, to redeem Fab assets. To do so, follow the steps below.
> 1. Navigate to the **code redemption** page. （该链接 href = `https://www.epicgames.com/account/code-redemption`）
> 2. Log in or sign up for an **Epic Games account**.
> 3. Enter the code, then click **Redeem**.
> 4. Click **Confirm** under the confirmation message.

要点：**两步确认**（Redeem → Confirm），与 Humble 旧文 `[S7]`（§5）描述的「press 'Redeem' → Hit 'Confirm'」一致。两个互相独立的一手来源均确认这一点。

### 2.2 实测的 URL / 重定向链路（已验证）

```
GET https://www.epicgames.com/account/code-redemption
  → 302  https://accounts.epicgames.com/account/code-redemption
  → 302  https://accounts.epicgames.com/auth/login?returnPath=%2Faccount%2Fcode-redemption
           &clientId=007c0bfe154c4f5396648f013c641dcf
  → 302  https://www.epicgames.com/id/api/login
           ?client_id=007c0bfe154c4f5396648f013c641dcf
           &redirect_uri=https%3A%2F%2Faccounts.epicgames.com%2Fauth%2Fcallback
           &response_type=code&state=<random>
```

即这是一个标准的 **OAuth 2.0 授权码流程**（`response_type=code` + `state` + `redirect_uri`），client_id 为 `007c0bfe154c4f5396648f013c641dcf`（accounts.epicgames.com 的 Web 客户端）。Fab 前端代码里也能看到 `oauth_callback_state` 与 5 分钟的状态 TTL，佐证这是网页 OAuth 回调登录 `[S4]`。

> 验证方式：
> `curl -s -D - -o /dev/null "https://www.epicgames.com/account/code-redemption"`（读 `Location` 头，逐跳）
> `curl -s -I "https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncher.msi"`

### 2.3 `fab.com` 上不存在兑换页（已验证）

| 请求 | 结果 | 含义 |
|---|---|---|
| `GET https://www.fab.com/redeem` | **404**（3474B，Fab 自带 "Page not found"） | 不存在 |
| `GET https://www.fab.com/account/code-redemption` | **404 ×3**（稳定复测） | 不存在 |
| `GET https://www.fab.com/redeem-code`、`/account/redeem`、`/code-redemption` | 404 | 不存在 |
| `GET https://www.fab.com/library`、`/library/purchased`、`/cart` | **302**（跳登录） | 存在，但需登录 |
| `GET https://www.fab.com/this-path-does-not-exist-xyz123` | 404（对照组） | — |

Fab 前端路由表（取自其 JS bundle 的 route 定义）里包含 `library`、`library/licensed`、`library/on-disk`、`library/assets/<uuid>`、`library/my-assets`、`library/purchased`、`cart`、`payment/web/purchase`、`search/:kind?/:slug?`、`blade/:id`、`category/:listingType/:categorySlug?`——**没有任何 redeem 路由** `[S4]`。

> 注意：单次 403 是 Cloudflare 挑战噪声（同一路径复测会变 404），不能当作「存在」的证据；上表用 3 次复测 + 对照组排除。

### 2.4 登录态与人机校验

- Fab 页面注入 `https://js.hcaptcha.com/1/api.js?render=explicit&uj=true` → **使用 hCaptcha**（显式渲染模式）`[S3]`。
- `www.fab.com` 全站在 Cloudflare managed challenge 之后（响应含 `cf_chl_opt`、`cType: 'managed'`、"One more step"，并下发 `__cf_bm` cookie）；实测同一 URL/头组合会时而 200、时而 403 `[S3]`。
- Fab 文档明确：浏览免费资产可匿名，但**要加入 library 必须登录**；兑换码路径同样要求登录 `[S2]`。

### 2.5 兑换后资产在哪（已验证）

Epic 官方文档列出 4 个访问点 `[S2]`：Fab 网站、Fab in Launcher（Epic Games Launcher 内）、**UE 集成（Fab 插件，UE 5.3+）**、UEFN 集成。其中：

- My Library（`fab.com/library`）可下载「applicable assets」；
- **UE / UEFN 格式**必须在 Fab 集成或 Epic Games Launcher 的 My Library 里下载进工程；
- UEFN 文件**不会**出现在 library 中。

---

## 3. 可用接口盘点（Fab / Epic），兼论游戏本体商店为何不适用

### 3.0 为何 Steam / GOG / EA App / Ubisoft Connect / Battle.net 不适用

这几个商店兑换的都是**游戏本体 license**（或游戏内 DLC/钱包），不是「游戏开发资产」，因此与本项目（引擎素材包管家）无关，本轮**剔除**：

- Steam：兑换得到的是绑定到账号的 **Steam package / app license**。虽然它确实有可自动化的接口（网页 `POST /account/ajaxregisterkey/` + `sessionid`，或客户端协议 `Store.RegisterCDKey` / `EMsg.ClientRegisterKey`），但对象是游戏本体。「有接口」不改变「不适用」的结论。
- Epic Games Store：`com.epicgames.launcher://store/redeem`、`epicgames.com/redeem`（礼品卡）针对游戏/钱包，非 Fab 资产。
- GOG / EA App / Ubisoft Connect / Battle.net：Humble 对其交付的是游戏本体 key，与资产包无关；本轮未做进一步调研。

> 存档备查（若未来范围再扩到游戏本体才用得上）：Steam 侧的一手证据见 `[S9]`（官方网页 JS 的错误码文案、`EPurchaseResultDetail` 枚举、ASF 的 1 小时限速注释）。

### 3.1 结论：不存在可 API 化的官方批量兑换接口

| 候选接口 | 是否存在 | 证据 |
|---|---|---|
| Fab 官方公开 REST API（含 redeem） | **否（未发现任何官方文档）** | Epic Fab 文档把访问方式限定为网站 / Launcher / UE 插件 / UEFN，未提 API `[S2]` |
| Fab 内部 Web API `https://www.fab.com/i/...` | **存在，但内部且无 redeem 端点** | 见 §3.2 |
| Epic `accounts.epicgames.com` 兑换接口（JSON） | **未验证**（只有网页 OAuth + 表单，未见公开 JSON 端点） | §2.2 |
| Epic OAuth（授权码流程） | **存在**（官方账号系统） | §2.2 实测 302 链路 |
| `com.epicgames.launcher://store/redeem` | 存在，但属于 **Epic Games Store** 兑换，非 Fab | §3.3 |
| EOS Entitlements / Ecom 接口 | 面向「你自己在 EOS 上架的产品」，**不适用于 Fab 兑换** | 开放问题 §9 |

### 3.2 Fab 内部 Web API（已验证存在的端点，未公开文档）

`https://www.fab.com/i/...` 返回 JSON。实测：

| 端点 | 无登录态结果 | 说明 |
|---|---|---|
| `GET /i/layouts/homepage` | **200** `application/json`（195 944 B） | 需要浏览器式头部（含 `Referer: https://www.fab.com/`、`sec-fetch-*`）才不被 Cloudflare 拦 |
| `GET /i/users/me` | **401** `{"detail":"Authentication credentials were not provided."}` | 典型 Django REST Framework 错误体 → 会话 cookie 鉴权 |
| `GET /i/csrf` | **200** `{}` | 配合 `core.getCsrf` 使用 |
| `GET /i/redeem` | **404**（Fab "Page not found" HTML） | **不存在** |

Fab 首页服务端预取数据（`js-json-data-prefetched-data`）里出现的 API 键：`/i/users/me`、`/i/channels`、`/i/taxonomy/categories/tree`、`/i/taxonomy/listing-types`、`/i/taxonomy/listing-types/asset-format-types`、`/i/taxonomy/asset-format-types`、`/i/taxonomy/listing-type-groups`、`/i/layouts/homepage` `[S3]`。

其 JS bundle 里还能看到这些前端调用的相对路径 `[S4]`：`/users/me/wishlist-alerts`、`/portal/sales/verify-order?order_id=`、`/entitlements/quixel/claim-assets`、`/sellers/name/<name>/trader-info`、`/users/me/address-verification-url`、`/i/listings/<uid>`、`/i/portal/listings/<uid>/unlist`。

**鉴权细节（已验证）** `[S4]`：

- CSRF cookie 名 = `fab_csrftoken`；请求头 = `X-CsrfToken`；无 token 时填 `"skfb-no-token"`；表单另用 Django 的 `csrfmiddlewaretoken`；
- 请求 `credentials: "same-origin"`；
- 服务端下发 Cloudflare `__cf_bm` cookie。

> 含义：即使绕过 UI 直接打 API，也必须持有**浏览器登录态 cookie 集合**（Epic 会话 + `fab_csrftoken`），且要过 Cloudflare。API 化并不比浏览器自动化更省事。

### 3.3 Epic Games Launcher 深链协议（已验证）

`https://www.fab.com/` 内联的运行时配置（`<script id="js-json-data-sketchfab-runtime">`）原样给出 `[S3]`：

```json
{
  "epicLauncherRedeemUrl": "com.epicgames.launcher://store/redeem",
  "epicLauncherFabUrl": "com.epicgames.launcher://fab",
  "epicLauncherVaultUrl": "com.epicgames.launcher://ue/library",
  "epicLauncherUnrealEngineUrl": "com.epicgames.launcher://ue",
  "epicLauncherLibraryUrl": "com.epicgames.launcher://store/library",
  "epicCartServicePublicBaseUrl": "https://list-public-service-prod.ol.epicgames.net/list",
  "epicFabMerchantGroup": "UE_MKT",
  "epicFabLiveNamespace": "89efe5924d3d467c839449ab6ab52e7f",
  "uploadServerUrl": "https://upload.fab.com"
}
```

注意：`store/redeem` 是 **Epic Games Store 的礼品卡/兑换**深链，不是 Fab 资产码兑换。Fab 侧的深链是 `com.epicgames.launcher://fab` 与 vault 的 `ue/library`。

另外一个易混淆点（已实测排除）：`https://www.epicgames.com/redeem` 是 **礼品卡余额充值页**（`<title>Gift Card | Epic Games</title>`，`og:description` = "Redeem your Epic Games Gift Cards to your Epic Account Balance..."），**与 Fab 兑换码无关** `[S5]`。

---

## 4. 回执判定与风控

### 4.1 成功

**已验证**：兑换页两步确认后，商品出现在 **Fab My Library**（Epic 官方文档 `[S2]`：redeem 后可从 "the Epic Games launcher, the Fab library, or within the Fab plugin" 下载）；Humble 侧表述为「instantly added to your library」`[S1]`。

可靠判定方式（推荐）：兑换动作完成后，**查询 `fab.com/library`（My Library）中是否出现对应 listing**，而不是只信页面提示文案。

### 4.2 已拥有 / 无效 / 已过期 / 区域受限 / 需额外步骤

- **「需额外步骤」** 是唯一有官方明确说明的分类（已验证）：UE/UEFN 格式需要 Launcher 的 Fab Library 或 UE 5.3+ Fab 插件才能进工程；UEFN 文件不进 library `[S2]`。
- **已拥有 / 无效 / 已过期 / 区域受限** 的**确切错误文案与错误码未验证**——Epic 的兑换页与 accounts 应用在 Cloudflare 之后且需登录，本轮无法在不登录的前提下取得其错误枚举。→ 见 §9 开放问题。
  - 参考：Humble 侧的 Blender Market 文章提到「Keys must be redeemed by the expiration date listed on your bundle download page」`[S6]`，说明 Humble 的 key 存在**兑换截止日期**概念；Fab key 是否强制截止未验证。

### 4.3 账号侧风控与限速

- **Fab 侧已观测到的风控（已验证）**：Cloudflare managed challenge（`__cf_bm`）+ **hCaptcha**（`render=explicit`）。这两者都必须在真实浏览器里完成。
- **Epic 兑换侧的限速阈值**：**未找到一手说明**，未验证（§9）。
- 参考对照（仅当未来重新纳入游戏商店时有意义）：Steam 的兑换限速有一手证据——Steam 自家网页 JS `registerkey.js` 明确把 `53` 定义为「There have been too many recent activation attempts from this account or Internet address」，并要求「wait 30 minutes」；ArchiSteamFarm 源码注释写 `RedeemCooldownInHours = 1; // 1 hour since first redeem attempt, this is a limitation enforced by Steam` `[S9]`。

---

## 5. 旧 Unreal Marketplace 兑换码在 Fab 上的可用性

**部分已验证：**

1. 旧 Unreal Marketplace 的 key 兑换入口**就是同一个页面**。Humble 的 *Unreal Engine - Key Redemption Instructions*（最后更新 `2024-02-14`，即 Fab 上线之前）第 1 步原文为：`Go to https://www.epicgames.com/account/code-redemption` `[S7]`。而 Epic 官方 Fab 文档给「code redemption page」的链接**也是这同一个 URL** `[S2]`。
2. 迁移后的资产可见性（Epic 官方 Fab 文档 *Assets Acquired Before Fab* FAQ，已验证）`[S2]`：
   - 「All UE products acquired from UE Marketplace are available in the **Fab Library of the Epic Games Launcher**. If a product is published on Fab, that product will also appear in Fab under **My Library**.」
   - 免费获取的资产与付费资产待遇**无差别**。
   - 许可证沿用 **Epic Content License Agreement（UE Marketplace License）**；若在 Fab 上重新下载，一般仍适用旧许可证（新增文件格式除外）。
   - 「It is not anticipated that your previously acquired products will be removed from your UE Vault (now called **Fab Library**).」

**推断（未验证）**：既然新旧文档指向**同一个兑换页 URL**，旧未兑换码大概率仍可在 Fab 流程中兑换；但 Epic 未文字化承诺这一点。→ §9。

---

## 6. Linux（仅 Linux 目标平台）专属结论

**已验证（官方原文）：**

- 「**Fab in Launcher is only available on Windows and Mac.**」——Epic 官方文档 *Exporting Assets from Fab in Launcher* `[S8]`。
- Epic 安装包目录实测 `[S9]`：
  - `EpicGamesLauncherInstaller.msi` → **303**（存在）
  - `EpicGamesLauncher.dmg` → **303**（存在）
  - `EpicGamesLauncher.deb` → **404**
  - `EpicGamesLauncher.rpm` → **404**
- Fab in Launcher 的导出目标（UE / Unity / Maya / 3ds Max / Blender / Cinema 4D）与插件路径均只列 Windows/Mac `[S8]`。

**对本项目的含义（推断，但有据）：**

1. Linux 上**没有官方 Epic Games Launcher**，因此 Humble 文章第 5–7 步（Launcher → vault → Add to Project）在 Linux 不可用。
2. Linux 上获取 UE 格式资产的官方路径退化为：**浏览器 fab.com 的 My Library 下载** + **Unreal Engine 5.3+ 的 Fab 插件**（UE 支持 Linux）。Fab 文档也确认插件随 5.3+ 提供 `[S2]`。
3. 由于没有 Linux 客户端，**不存在可借用的「Epic 客户端票据」**（不像 Steam 有 CM 协议票据）；能复用的只有浏览器登录态。
4. Linux 下浏览器自动化的落地建议（工程推断）：Playwright/Chromium 持久化 profile 保存 Epic 会话；凭据与 cookie 走 libsecret / gnome-keyring（而非 macOS Keychain）；Epic 的 2FA 与新设备验证需人工介入一次。
5. 内嵌 browser 需支持 hCaptcha 与 Cloudflare managed challenge（即必须是真实浏览器内核 + 真实 JS 执行，纯 HTTP 客户端不可靠）。

---

## 7. 总表

| 商店 | 兑换对象 | 可 API 化？ | 所需凭据 | 自动化难度 | 建议方案 |
|---|---|---|---|---|---|
| **Fab（Epic，Humble 引擎资产包）** | 开发资产（素材包） | **否**（无官方公开接口；内部 `/i/` API 无 redeem 端点 + Cloudflare + hCaptcha） | **Epic Games 账号登录态**（网页 OAuth 授权码 + 会话 cookie） | **高**（登录/2FA/hCaptcha/Cloudflare 挑战需真实浏览器） | **浏览器自动化（内嵌浏览器）**；人工只做首次登录/2FA；兑换与 My Library 校验可自动 |
| Steam | **游戏本体 license** | 是（但属游戏商店，见 §3.0「不适用」） | Steam 账号 + 客户端票据 / 网页 session + `sessionid` | — | 不适用（剔除） |
| GOG | 游戏本体 | — | — | — | 不适用（剔除） |
| EA App / Origin | 游戏本体 | — | — | — | 不适用（剔除） |
| Ubisoft Connect | 游戏本体 | — | — | — | 不适用（剔除） |
| Battle.net | 游戏本体 | — | — | — | 不适用（剔除） |
| Unity Asset Store | 引擎资产（voucher/码） | 否（未发现公开接口） | Unity ID 登录态 | 中（网页表单 + 组织/seat 选择） | 附录路标；未来若纳入则浏览器自动化 |
| 旧 Unreal Marketplace | 引擎资产（码） | 否 | Epic Games 账号 | 中 | 已并入 Fab 同一兑换页（§5） |

**「必须浏览器自动化」环节中最容易变化、最需要模型决策的点（Fab）：**

1. **Cloudflare managed challenge + hCaptcha**——命中时机不固定（同一 URL 时 200 时 403），是否弹验证码无法预测，必须由模型/人判断「继续、等待、还是转人工」。
2. **Epic 登录 + 2FA + 新设备验证**——页面可能重定向到 `epicgames.com/id/...`，DOM 变体多；是否要验证码、是否要邮箱确认，需模型读页面决定。
3. **兑换表格的两步确认（Redeem → Confirm）与错误文案**——错误提示文案非结构化，且我们未取得错误码枚举（§9）；「无效 / 已兑换 / 区域受限 / 已拥有」的区分只能靠读页面文案。
4. **兑换后的归属校验**——不能只信成功提示，要回到 My Library 搜索 listing 名称确认 entitlement 真的落地。
5. **区域 / EULA 接受步骤**——Fab 文档提到 EU 可用性过滤、EULA 弹窗确认等分支，需要在页面上做判断。

---

## 8. 附录（一屏）：其它资产商店路标

| 商店 | 交付形态 | 是否有接口 | 是否必须浏览器自动化 | 难度 |
|---|---|---|---|---|
| **Unity Asset Store** | Humble 发 **voucher / product code**，在 `https://id.unity.com/en/redeem_products/new` 或 `https://assetstore.unity.com/humble-bundle-redemption` 兑换；兑换后要选 organization 并 **assign seats** `[S10]` | 未发现公开兑换 API | 是（网页表单 + 组织选择） | 中 |
| **旧 Unreal Marketplace** | 码，兑换页 = `epicgames.com/account/code-redemption`（与 Fab 同一页）`[S7]` | 否 | 是 | 中（已并入 Fab） |
| **Blender Market** | Humble 发 **coupon code**，在 blendermarket.com 选变体 → 输入 coupon → 走 checkout `[S6]` | 未发现公开接口 | 是 | 中 |
| **itch.io** | Humble 发 **key link**，点链接把内容 claim 到账号（不是输入码）`[S11]` | 无（claim link 机制） | 是（点链接受登录态约束） | 低 |
| **CGTrade** | **未能验证**（未找到一手来源） | 未知 | 未知 | 未知 |
| （GameMaker Marketplace） | 用户提到可能有；**本轮未验证** | 未知 | 未知 | 未知 |
| Humble 直接下载（DRM-free） | 用户已确认本轮不涉及 | — | — | — |

---

## 9. 未能验证 / 开放问题

1. **Epic 兑换码的确切错误码 / 文案枚举**（无效、已被他人兑换、已过期、区域受限、已拥有、需要额外步骤）。兑换页需登录且被 Cloudflare 保护，本轮未取得。**这是最需要补的一项**——建议后续用一次性授权的人工登录抓取页面实际报错。
2. **是否存在未公开的 Epic 兑换 JSON 端点**（如 accounts.epicgames.com 下的 POST）。本轮只取得网页表单 + OAuth 链路，未发现 JSON 端点；未做进一步探测以免臆造端点。
3. **Fab profile 菜单里「Redeem Code」到底指向哪里**：Humble 文章说「Fab.com → profile → Redeem Code」`[S1]`，而 Epic 官方文档给的是 `epicgames.com/account/code-redemption` `[S2]`。两者可能是「Fab 菜单外链到 Epic 账号页」，但**未验证菜单项的实际 href**（需要登录后看 DOM）。
4. **旧 Unreal Marketplace 未兑换码在 Fab 是否 100% 仍可兑换**：同 URL 是强证据，但 Epic 无明文承诺。
5. **Epic / Fab 兑换的限速阈值与封控触发条件**：未找到一手说明。
6. **「已拥有该资产的重复码」如何处理**（拒绝 or 合并）——未验证。
7. **Fab key 是否有强制兑换截止日期**：Humble 对某些 bundle 有截止日期概念 `[S6]`，Fab key 未验证。
8. **EOS Entitlements / Ecom 接口能否用于查询 Fab entitlement**：Epic 的 EOS 接口面向自有产品，**未经证实**可用于 Fab；本轮未验证其文档可达性（Epic 文档站亦在 Cloudflare 后）。
9. **Fab 内部 API 的稳定性与 ToS 风险**：`/i/` 端点未公开文档，随时可能变更；依赖它属于灰色地带。
10. **CGTrade / GameMaker** 的 Humble 交付形态：本轮未取得一手来源。

---

## 10. 来源清单（一手）

- `[S1]` Humble Bundle Help Center — *FAB Keys - Redemption Instructions*（id 53302161018651，更新 2026-09-22）
  https://support.humblebundle.com/hc/en-us/articles/53302161018651-FAB-Keys-Redemption-Instructions
  取法：`curl -s "https://support.humblebundle.com/api/v2/help_center/en-us/articles/53302161018651.json"`
- `[S2]` Epic Games 官方 Fab 文档 — *Purchasing and Downloading Assets in Fab*
  https://dev.epicgames.com/documentation/en-us/fab/purchasing-and-downloading-assets-in-fab
  （Product Keys 小节的 "code redemption" 链接 href = `https://www.epicgames.com/account/code-redemption`；含 "Assets Acquired Before Fab" FAQ、My Library、UEFN/UE 下载限制、Quixel 组织直授）
- `[S3]` `https://www.fab.com/` 首页响应（含 `js-json-data-sketchfab-runtime` 运行时配置、hCaptcha `<script src="https://js.hcaptcha.com/1/api.js?render=explicit&uj=true">`、`js-json-data-prefetched-data` 预取 API 键）
  取法：`curl --compressed -A '<Chrome UA>' -H 'Referer: https://www.fab.com/' ... https://www.fab.com/`
- `[S4]` Fab Web 客户端 JS bundles（`https://static.fab.com/static/builds/web/dist/*-v1.js`）：route 表、`fab_csrftoken` / `X-CsrfToken`、`oauth_callback_state`、`/csrf`、`/entitlements/quixel/claim-assets` 等
- `[S5]` `https://www.epicgames.com/redeem`（实测 200，`<title>Gift Card | Epic Games</title>`，礼品卡余额页）
- `[S6]` Humble Bundle Help Center — *Blender Market's Essential Game Modding Toolkit*（id 26912354384411）
  https://support.humblebundle.com/hc/en-us/articles/26912354384411
- `[S7]` Humble Bundle Help Center — *Unreal Engine - Key Redemption Instructions*（id 360056175594，更新 2024-02-14）
  https://support.humblebundle.com/hc/en-us/articles/360056175594-Unreal-Engine-Key-Redemption-Instructions
- `[S8]` Epic Games 官方 Fab 文档 — *Exporting Assets from Fab in Launcher*
  https://dev.epicgames.com/documentation/en-us/fab/exporting-assets-from-fab-in-launcher
  （原文："Fab in Launcher is only available on Windows and Mac."）
- `[S9]` Steam 侧对照证据（游戏本体，仅存档备查）：
  - Steam 自家网页 JS：`https://raw.githubusercontent.com/SteamTracking/SteamTracking/master/store.steampowered.com/public/javascript/registerkey.js`（错误码 14/15/53/13/9/24/36 的官方文案）
  - `EPurchaseResultDetail` 枚举：`https://raw.githubusercontent.com/ValvePython/steam/master/steam/enums/common.py`
  - ArchiSteamFarm：`https://raw.githubusercontent.com/JustArchiNET/ArchiSteamFarm/main/ArchiSteamFarm/Steam/Bot.cs`（`RedeemCooldownInHours = 1; // 1 hour since first redeem attempt, this is a limitation enforced by Steam`）
  - launcher 安装包探测：`https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/<file>`
- `[S10]` Humble Bundle Help Center — *Unity Assets - Redemption Instructions*（id 360008549494，更新 2026-08-13，含 `https://id.unity.com/en/redeem_products/new`）；*Unity Bundle Redemption Instructions*（id 7529317957915）
- `[S11]` Humble Bundle Help Center — *Itch.io - Redemption Instructions*（id 36347720060571）
