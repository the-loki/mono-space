# 验证 #18：Epic 兑换的错误码与文案枚举

- 票据：the-loki/mono-space#18（wayfinder task，原计划 HITL）
- 验证日期：2026-09-26
- 方法：**不登录**，直接取 Epic 自家前端 localization bundle（`window.EGStoreCtx.localizationData.messages`），并用真实 Chromium 复取 2026 现行版本。原票要求「人工登录一次」才能拿到的错误枚举，实际可从 Epic 自己的公开前端数据取得，且比逐条手点更完整。

> **状态更新（2026-09-27）**：本报告的**证据仍然成立**（26 条错误码与文案、2FA 形态、风控事实），
> 但它原来服务的那条**代码驱动归类链已删除**（ADR-0005）。现在兑换改为**代理驱动**：
> 分类由 agent 看着页面原文自己判，错误码表不再被任何代码引用，仅作**参考材料**
> 供 agent （和排查的人）读懂页面报错。§2 的「归类→状态机输入」因此是**历史映射**，
> 不是现行实现；现行形态见 `docs/spec/12` §11。

---

## 0. 结论先行

1. **错误码枚举已拿到（2026 现行）**：见 §1，共 **26 条**兑换相关错误码 + 完整英文文案，覆盖「无效 / 已用 / 已过期 / 已拥有 / 区域受限 / 前置不足 / 未成年人 / 节流 / 需人工」全部目标场景。
2. **可归类为 7 类结果**（§2），足以支撑 `#12` 的结果状态机；未知码一律落「需人工」。
3. **Fab 的「Redeem Code」菜单项确实存在**（Fab i18n bundle 里有 `redeemCode: "Redeem Code"`，属 profile 下拉菜单），但**未登录看不到它的 href**；Epic 官方文档给的 `epicgames.com/account/code-redemption` 与 Humble 指引的「Fab → profile → Redeem Code」高度指向同一页。**确切 href 仍需一次登录确认**（§3，列为 HITL 残差）。
4. **2FA 形态确认**：TOTP（认证器 App）/ 邮件 / SMS 三选一，可多绑并设主方法；Epic 官方明确 **2FA 会在「新设备、启用后首次、超过 30 天未登录、清过 cookie」时重新索要**——没有独立的「记住此设备」开关，**登录态 cookie 本身就是那份记忆**（§4）。这对 `#10` 的「登录一次长期复用」是决定性的：**可以长期复用，但约每 30 天或 cookie 丢失时需人工过 2FA。**
5. **额外硬事实**（来自 Epic 官方安全页）：Epic 对自动化登录**主动弹 CAPTCHA、有严格限速**，并封禁「专门用于欺诈的账号 / 破坏平台完整性的工具」。→ 支持半自动优先 + 低频节流，反对批量并发。

---

## 1. 错误码 → 文案枚举（2026 现行，原文）

来源：`https://store.epicgames.com/en-US/` 加载后读取 `window.EGStoreCtx.localizationData.messages`，筛 `coderedemption|redemption`。

| # | 错误码 | 英文文案（原文） |
|---|---|---|
| 1 | `errors.com.epicgames.coderedemption.code_not_found` | Code does not exist. |
| 2 | `errors.com.epicgames.coderedemption.invalid_code` | Redemption code is invalid. |
| 3 | `errors.com.epicgames.coderedemption.invalid_code_status` | The code is not in active status. |
| 4 | `errors.com.epicgames.coderedemption.code_not_active` | The code is not activated yet. |
| 5 | `errors.com.epicgames.coderedemption.code_required` | Redemption code is required. |
| 6 | `errors.com.epicgames.coderedemption.code_used` | This redemption code has already been used. |
| 7 | `errors.com.epicgames.coderedemption.code_expired` | The code has expired. |
| 8 | `errors.com.epicgames.coderedemption.unsupported_namespace` | This type of code cannot be redeemed on this website. Please visit {0}. |
| 9 | `errors.com.epicgames.coderedemption.product_owned` | Your code was not redeemed because you already have this product. |
| 10 | `errors.com.epicgames.coderedemption.multiple_redemptions_not_allowed` | Cannot redeem the same code more than once. |
| 11 | `errors.com.epicgames.coderedemption.code_use_expired` | Code redemption failed. Please contact customer service with the code you entered. |
| 12 | `errors.com.epicgames.coderedemption.code_use_not_found` | Code redemption failed. Please contact customer service with the code you entered. |
| 13 | `errors.com.epicgames.coderedemption.codeUse_already_used` | Code redemption failed. Please contact customer service with the code you entered. |
| 14 | `errors.com.epicgames.coderedemption.batch_not_found` | Code redemption failed. Please contact customer service with the code you entered. |
| 15 | `errors.com.epicgames.coderedemption.account_not_allowed_redeem` | The code belongs to other account, redemption is not allowed. |
| 16 | `errors.com.epicgames.coderedemption.region_not_allowed_redeem` | This code can only be used for accounts in the specified country. Please use another code, or contact our customer support. |
| 17 | `errors.com.epicgames.ecommerce.fraud.geo_locked_redemption` | This code can only be used for the specified country. Please make sure you are not using any applications that would alter your location information. If you continue to have issues, please contact our customer support. |
| 18 | `errors.com.epicgames.coderedemption.client_not_allowed_redeem` | The code is not allowed to redeem by this client. |
| 19 | `errors.com.epicgames.coderedemption.invalid_code_criteria` | We cannot process your request, please contact our customer service. |
| 20 | `errors.com.epicgames.coderedemption.criteria.reject` | We cannot process your request, please contact our customer service. |
| 21 | `errors.com.epicgames.coderedemption.reject_on_fraud` | We cannot process your request, please contact our customer service. |
| 22 | `errors.com.epicgames.coderedemption.criteria.content_already_owned` | You already have this product, so we can not redeem this code. |
| 23 | `errors.com.epicgames.coderedemption.criteria.content_partial_owned` | You have one or more items for this code, so you can not redeem. If you feel like this is a mistake, please contact Customer Support. |
| 24 | `errors.com.epicgames.coderedemption.criteria.missing_entitlement` | You do not meet the prerequisite to redeem this code. |
| 25 | `errors.com.epicgames.ecommerce.fulfillment.reach_offer_redemption_limit` | We're unable to process your request. You have already redeemed your code(s) and reached this product's redemption limit. |
| 26 | `errors.com.epicgames.coderedemption.account_redemption_meet_limit` | Code redemption unsuccessful. Please review the entered code or contact customer service for assistance. |

### 1.1 与 2022 快照的差异（说明这份枚举是「活的」）

对照 2022-12-03 的公开快照（`store.epicgames.com` 同源数据），现行版本至少有两处变化：

- `reach_offer_redemption_limit` 文案从 "This code has already been redeemed..." 改为 "…reached this product's redemption limit."（语义从「码被用过」变为「达到该商品兑换上限」，归类从「已用」转向「限额」）。
- 新增 `coderedemption.account_redemption_meet_limit`（2022 快照没有）。

→ **结论：文案会变，错误码相对稳定。实现期应以错误码为主键、文案只作兜底匹配**；且要在实现时用活页复取一次（见 §5）。

### 1.2 与兑换流程 UI 有关的字符串（2026 现行）

| key | 文案 |
|---|---|
| `epic.store.redemptionForm.title` | Redeem your product |
| `epic.store.redemptionForm.description` | Enter the product code distributed with a retail DVD or other Epic Games product code here. |
| `epic.store.redemptionForm.description.locked` | Note: Your code will be locked while you sign into your account. |
| `epic.store.redemptionForm.placeholder` | 00000-00000-00000-00000 |
| `epic.store.redemptionForm.submit` | Redeem |
| `epic.store.redemptionForm.redeem_another_code` | Redeem another code |
| `epic.store.redemptionForm.imageAside` | The content will be bound to your Epic Games account forever, so make sure you sign in to the correct account when prompted |
| `epic.store.redemptionForm.imageAside.new` | Make sure you're signed in to the right account! Funds and purchases can't be transferred. |
| `epic.store.redemptionForm.status.pending.title` | Awesome, you're almost done! |
| `epic.store.redemptionForm.status.pending.description` | Before you can access your content, you'll need to sign in or create an account. |
| `epic.store.redemptionForm.status.pending.cta` | Sign In |
| `epic.store.redemptionForm.status.redeeming.title` | Redeeming Code |
| `epic.store.redemptionForm.status.redeeming.description` | Please wait... |
| `epic.store.redemptionForm.status.success.title` | You Redeemed Successfully! |
| `epic.store.redemptionForm.status.success.description` | Open the launcher to start downloading the game. |
| `epic.store.redemptionForm.status.confirm.msg.fnCrew` | By redeeming this code, I agree to the [EULA](…) and the [Fortnite Crew Terms](…) |

> 注意：以上是 **Epic Games Store（`store.epicgames.com`）** 的兑换表单文案。项目实际要走的是 **账号侧兑换页 `epicgames.com/account/code-redemption`**（见 §3），两处 UI 文案可能不同；但**后端错误码是同一套**（`errors.com.epicgames.coderedemption.*` 是服务端标识）。
> （原文此处写「实现期以页面渲染文本为准做兜底、以错误码为准做主判定」——那属已删除的代码驱动栈；现在由 agent 读页面原文自己判，见文首状态更新。）
>
> `status.confirm.msg.fnCrew` 佐证兑换存在**显式确认/同意步骤**（至少对需要 EULA 的商品），与 Humble 文档的「Redeem → 再点 Confirm」两步一致。

---

## 2. 归类 → 结果状态机输入（给 #12）

> ⚠️ **历史映射（ADR-0005）**：下表曾是代码里的归类表（已随 `status.ts` 删除）。
> 现在的分类由 agent 在页面上完成；下表仍可当作「错误码 ↔ 结果状态」的参考词表。

把 §1 的 26 条码归成 7 类，作为状态机的分类输入：

| 归类 | 含义 | 命中错误码 | 建议状态机处置 |
|---|---|---|---|
| **无效** | 码本身不合法/不存在/未激活 | 1,2,3,4,5,19 | 终态「无效」，不重试 |
| **已用** | 码已被兑换（含被他人占用） | 6,10,11,12,13,15 | 终态「已用」；15 提示归属他账号 |
| **已过期** | 码过期 / 商品下架 | 7 | 终态「已过期」；若码来自旧 batch 也归此 |
| **已拥有** | 账号已持有该商品（含部分拥有） | 9,22,23 | 终态「已拥有」= 视同成功入账，**不重试** |
| **区域受限** | 账号国家/地区不匹配 | 16,17 | 终态「区域受限」，**需人工**（改区不可行） |
| **前置不足 / 需额外步骤** | 缺前置 entitlement、未成年人受控账号、订阅冲突、需去别处兑换 | 8,24,26 | 暂停「需人工」，带下一步指引 |
| **限额 / 风控 / 需人工** | 达到兑换上限、fraud 拒绝、未知码、缺批次 | 14,18,20,21,25 | 暂停「需人工」；21 属风控，**停止本批** |

补充：

- **节流**：`errors.com.epicgames.common.throttled`（"Sorry, you are visiting our service too frequent, please try again later."）— 不在兑换命名空间内但通用；命中即**指数退避 + 暂停批次**，呼应 `#7` 的「失败有限重试后入需人工队列」。
- **登录态失效**：`errors.com.epicgames.unauthorized`（"Code redemption failed, please log out and log back in to try again."）与 `ecommerce.subscription.invalid_account`（"Code redemption failed, please log back in and try again."）→ 呼应 `#11` 的「会话失效中止整批、重登后重跑」。
- **兜底原则**：**任何未在表内的码 → 「需人工」**，不猜测、不重试。

---

## 3. Fab 的「Redeem Code」入口（部分确认）

**已确认**：Fab 的前端 i18n bundle（`https://static.fab.com/static/builds/web/dist/ae22fc3268c93a864d0bce9e3eab13df-v1.js`）profile 下拉菜单段里有：

```
"manageAccount":"Manage Account","redeemCode":"Redeem Code","logout":"Logout",
"actionsMenuAreaLabel":"Profile Dropdown list", ...
```

→ **Fab 的 profile 下拉里确实有一项 "Redeem Code"**，与 Humble 帮助中心《FAB Keys - Redemption Instructions》的步骤一致。

**未确认（HITL 残差）**：该项的**确切 href**。未登录时 profile 下拉只有 Sign in / Sign up，菜单项不渲染，因此拿不到 `href`。已知线索：

- Epic 官方 Fab 文档给的兑换页是 `https://www.epicgames.com/account/code-redemption`；
- 在 Fab 已加载的 bundle 里能找到同类的 Epic 账号子页 URL：`https://www.epicgames.com/account/payments`、`https://www.epicgames.com/account/messaging`；
- 实测 `https://www.epicgames.com/account/code-redemption` 302 → `accounts.epicgames.com/account/code-redemption` → 登录 OAuth。

→ **强推断**：Fab 菜单项外链到 `https://www.epicgames.com/account/code-redemption`，即「Fab profile 菜单」与「Epic 账号兑换页」是**同一条外链**。但**未验证**，需登录后读 DOM 确认。

---

## 4. Epic 2FA 形态与「登录一次长期复用」

**已确认（Epic 官方帮助/新闻页，一手）**：

- **三种 2FA 方式**：认证器 App（TOTP）、邮件验证码、SMS 验证码；可同时启用多种，并指定「主 2FA 方法」。认证器 App 官方点名 Google / LastPass / Microsoft Authenticator、Authy。
- **触发时机（官方原文，fortnite.com/news/2fa）**：启用后首次登录、**新设备**、**超过 30 天未登录**、**最近清过浏览器 cookie**，都会重新索要 2FA 码。
- **恢复途径**：2FA 提示页有 "Try another way" → 邮件验证 或 **8 位 backup code**。

**对本项目的判定**：

1. **没有独立的「记住此设备」开关**；长期免 2FA 靠的是**登录态 cookie 存活**（与 `#2` 的 Humble `_simpleauth_sess` 同构的范式）。
2. 「登录一次长期复用」**成立但有限**：**预计约每 30 天、或 cookie 丢失/换机器时，需要人工过一次 2FA**。这应作为常态暂停节点（呼应地图 Notes 的「人在环路是常态节点」），而不是异常。
3. 因此 `#10` 的结论需补一句：**Epic 侧约 30 天一次人工 2FA**；`#7` 的「登录与人机校验暂停点」直接覆盖它。
4. 启用 **SMS 会绑定手机号**（换号要走人工流程）；**TOTP 或邮件对自用工具更稳**（无手机号耦合）。

**额外风控事实（Epic 官方安全页，一手）**：「Epic proactively… challenge automated login attempts with CAPTCHA puzzles, apply strict rate limits, and block suspicious login requests…」。→ 登录与兑换都可能有 CAPTCHA + 限速；**批量并发与 Epic 的条款/风控相容性差**，与 `#7` 已定的「串行单条 + 人类节奏」一致。

---

## 5. HITL 残差（首次人工登录时顺手补，不阻塞本图）

以下三项必须登录态才能补全，**不构成 #12 的阻塞**（状态机已可用错误码兜底）：

1. **Fab profile → Redeem Code 的确切 href**：登录 Fab，打开 profile 下拉，读该项 `href`（预期 `https://www.epicgames.com/account/code-redemption`）。
2. **账号兑换页的实际渲染文案**：在 `epicgames.com/account/code-redemption` 依次触发——空码 / 明显无效码 / 已用码 / 区域受限码 / 已拥有商品——记录**页面显示文本**，与 §1 的错误码对照，确认账号页是「显示后端文案」还是「用自有文案」。
3. **2FA 记忆实测**：清 cookie 前后各登录一次，确认 30 天/新设备的实际表现；确认账号启用的 2FA 方法（TOTP/邮件/SMS）与是否有 backup code。

> 这三项写入 v1 的**首次登录引导 checklist**（`#14`），由人在环路首次跑通时完成，而不是留在本图当阻塞。

---

## 6. 原始证据

### 6.1 现行错误码复取（真实 Chromium，headed，2026-09-26）

```bash
export AGENT_BROWSER_SESSION="wayfinder18h" AGENT_BROWSER_ARGS="--no-sandbox" DISPLAY=:198
agent-browser open https://store.epicgames.com/en-US/
agent-browser eval "(()=>{const m=window.EGStoreCtx.localizationData.messages;return Object.keys(m).filter(k=>/coderedemption|redemption/i.test(k)).map(k=>k+' = '+m[k]).join('\n')})()"
```

输出即 §1 表格（26 条码 + redemptionForm 文案）。

### 6.2 关键环境事实（复现本报告时用）

- 本机 Ubuntu 26.04.1，AppArmor 限制 unprivileged userns（`No usable sandbox!`），Chromium 需 `--no-sandbox`。
- **headless Chromium 访问 fab.com 会卡在 Cloudflare 交互式 Turnstile**（「请完成安全检查以继续」，需真人点选）；**headed Chromium 一次通过、正常加载 Fab**。
- Epic 站：`curl` 裸请求 `epicgames.com/account/code-redemption` → `403 cf-mitigated: challenge`；`store.epicgames.com` 在 headed 浏览器下正常。

### 6.3 2022 对照快照

- `https://gist.github.com/woctezuma/4cacf4808656ef9f8eb833da9e162d28`（`window.EGStoreCtx.localizationData.messages`，2022-12-03）— 用于 §1.1 的差异对照。

---

## 7. 回灌清单

- **`#12`（Fab 兑换流程与状态机）**：§1 错误码枚举 + §2 七类归类，可直接作为状态机输入；`unsupported_namespace` 明确「需去别处兑换」分支。
- **`#10`（凭据/隐私）**：§4 — Epic 2FA 约 30 天重索，登录态 cookie 是唯一「长期记忆」；无独立「记住设备」。
- **`#7`（执行模型）**：§4 的风控/限速事实，佐证串行单条 + 人类节奏。
- **`#14`（v1 切片）**：§5 三项列入首次登录引导 checklist。
