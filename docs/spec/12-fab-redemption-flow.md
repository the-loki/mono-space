# 规格 #12：Fab 兑换流程的实现形态与结果状态机

- 票据：the-loki/mono-space#12（wayfinder grilling 决策票）
- 状态：**决策就绪**（写「就是什么」）
- 输入：`#3`（Fab 无公开兑换 API、唯一入口是 Epic 账号页）、`#18`（26 条错误码 → 7 类）、`#16`（Electron 扩展可装载/通信/热替换；client hints 硬约束）、`#9`/`#11`（代理只写扩展、运行期不过模型）、`#7`（串行单条 + 人类节奏 + 预检/单条试探）、ADR-0001/0002。

---

## 1. 决策摘要

| 决策点 | 结论 |
|---|---|
| 流程形态 | **只做「输入兑换码」**（Epic 账号兑换页 `Redeem → Confirm`）。**不预留**「claim 领取到账号」路径——Humble 引擎资产包以兑换码交付，这是唯一实证到的形态 |
| 兑换入口 | **`https://www.epicgames.com/account/code-redemption`**（302 → `accounts.epicgames.com` → Epic 网页 OAuth 登录）。**不用 `fab.com`**（无 redeem 路由，`fab.com/redeem` 稳定 404） |
| 回执校验 | 兑换成功后**回 `fab.com/library` 查该 listing**，以「库中出现」为最终成功判据，不只信页面提示 |
| 凭据 | **Epic 账号浏览器登录态**（私有 `persist:` 分区的 cookie）。不申请 OAuth API token、不需要 launcher（Linux 无 Launcher） |
| 确定性 vs 模型 | **日常全程确定性代码 + 扩展**；代理只在「选择器失效 / 陌生页面 / 结构变体」时**离线写/改扩展**，运行期不过模型 |
| 状态机 | 见 §6：`not_redeemed → precheck → probing →{redeemed / already_owned / invalid / used / expired / region_blocked / needs_human}`，任意点可暂停为 `needs_human` |
| 人在环路 | 首次登录、2FA、hCaptcha/Turnstile、陌生页面、重试耗尽、脚本疑似失效 = **一等暂停点**；会话失效 → **中止整批**，重登后重跑（重快照不重放） |

---

## 2. 流程形态：兑换码（唯一路径）

**证据**（`#3`，一手）：

- Humble 官方帮助《FAB Keys - Redemption Instructions》：登录 Fab → profile 菜单 **Redeem Code** → 输唯一 key → Redeem → 商品进库。
- Epic 官方 Fab 文档：code redemption page = `epicgames.com/account/code-redemption`，**输码 → Redeem → Confirm** 两步。
- `fab.com/redeem`、`fab.com/account/code-redemption`、`fab.com/redeem-code` 均 **404**；Fab 前端路由表**没有 redeem 路由**。
- Humble 引擎资产包 = **一次性兑换码**（不是账号直授；Quixel 组织直授是另一回事，与本项目无关）。

**因此定死**：
- 兑换对象是**兑换码**，动作是**在 Epic 账号页提交码**，不是在 Fab 上「claim/领取」。
- **不做**「claim 领取」分支，不做适配器预留（等第二家商店出现再说，见地图迷雾）。
- Fab 免费资产的「Add to Library」与 Humble key 无关，不纳入。

---

## 3. 凭据与会话

- **唯一凭据 = Epic 账号浏览器登录态**。它经 Epic 网页 OAuth 授权码流程建立（`accounts.epicgames.com`，`client_id=007c0bfe…`，`response_type=code`），落在应用私有 `persist:` 分区的 cookie 里。
- 该登录态**同时覆盖 `epicgames.com`（兑换页）与 `fab.com`（My Library 校验）**：Fab 登录正是经 Epic OAuth 派生的会话。
- **不**使用、不申请 OAuth API token（无官方公开 client、无官方兑换 API）。
- **不**依赖 Epic Games Launcher（Linux 上官方不支持 Fab in Launcher）。
- 会话寿命：约 **30 天**或换设备 / 清 cookie 会重索 2FA（`#18` §4）；cookie 丢失即重登。
- **所有 store session 出网必须补 `Sec-CH-UA` 客户端提示**（ADR-0002），否则兑换页直接 `403 cf-mitigated: challenge`。

---

## 4. 端到端流程（角色标注：C=确定性代码 / X=扩展脚本 / A=代理离线 / H=人）

| # | 步骤 | 角色 | 说明 |
|---|---|---|---|
| 0 | 台账里挑出「已揭示未兑换」的兑换码 | C | 真源在主进程台账 |
| 1 | **确定性预检**：会话有效？码非空且格式合法？My Library 是否已有该 listing？ | C | 预检失败 → `needs_human`，不起浏览器 |
| 2 | 打开/复用一个可见的兑换视图，导航到 `epicgames.com/account/code-redemption`（session 已补 CH） | C | 窗口默认可见可随时接管（`#7`） |
| 3 | **人机校验 / 2FA / 未登录** | H+C | 命中即暂停为 `needs_human`（一等公民）；完成后**重快照**继续，不重放 |
| 4 | 填码 → 点 **Redeem** | X | 选择器与流程由扩展写死；码由主进程经安全通道下发 |
| 5 | 若出现**确认/EULA**步骤 → 点 **Confirm** 并同意 | X | 两步确认是官方定义；同意动作的语义属敏感操作，见 §7 |
| 6 | 读结果：页面提示 + （若可拿到）**错误码** | X→C | **以错误码为主键**归类（`#18` §2），文案只作兜底 |
| 7 | 成功 → 导航 `fab.com/library`，**查 listing 是否出现** | C | 最终成功判据=库中可见；查不到 → `needs_human` |
| 8 | 归类并写入台账 | C | 见 §6 状态机 |
| 9 | 页面结构变化 / 陌生分支 → 抓快照（a11y 树为主）交代理 | C→A | 代理**离线**产出/修复扩展，人审后热替换 |

**串行与节奏（`#7`）**：**一次一条**，条间按人类节奏节流；不支持批量并发。多选只是「排队」，仍是串行执行。

---

## 5. 确定性代码与模型兜底的分界

**写死（确定性代码 / 扩展；不得交给模型）**
- 登录态检测、导航、填码、点 Redeem / Confirm、读取结果区。
- **错误码 → 状态归类**（纯映射，见 §6.3）。
- My Library 归属校验。
- 预检与单条试探的编排、串行与节流、台账写入。

**交代理（仅在离线生成/修复时）**
- 选择器 / 步骤失效（页面改版）→ 重写扩展脚本。
- 命中**从未见过的页面或分支**（新弹窗、额外确认、区域/资格提示、EULA 变体）→ 判断「是不是同一流程的变体」，产出脚本。
- 判断「这是变体还是陌生页」本身。

**代理绝不参与运行期**：不逐条调模型，不在流程中实时决策。运行期只有「确定性代码 + 扩展」；代理产出的脚本必须经**校验 + 人审/预检**后才热替换（`#13` 工具契约）。

---

## 6. 结果状态机

### 6.1 状态集合

| 状态 | 含义 | 终态 |
|---|---|---|
| `not_redeemed` | 已揭示、拿到码、尚未提交 | 否 |
| `precheck` | 确定性预检中 | 否 |
| `probing` | **单条试探**：提交第一条以观察真实反馈 | 否 |
| `redeeming` | 提交/确认中 | 否 |
| `redeemed` | 兑换成功且 **My Library 校验通过** | ✅ |
| `already_owned` | 账号已拥有该商品（含部分拥有）**视同成功** | ✅ |
| `invalid` | 码不存在 / 不合法 / 未激活 | ✅ |
| `used` | 码已被使用 / 被他人占用 / 达到兑换上限 | ✅ |
| `expired` | 码过期 / 商品下架 | ✅ |
| `region_blocked` | 区域/国家不匹配 | ✅（需人工，不可自愈） |
| `needs_human` | 前置不足、受控账号、风控、未知码、人机校验、陌生页、会话失效、重试耗尽 | 否（可恢复/可入人工队列） |

> 与票面命名对照：未激活=`not_redeemed`、领取中=`redeeming`、已领取=`redeemed`、已拥有=`already_owned`、无效=`invalid`、已过期=`expired`、需人工=`needs_human`；另补 `used` 与 `region_blocked`（`#18` 分类必需）。

### 6.2 迁移

```
not_redeemed --start--> precheck
precheck  --预检失败--> needs_human
precheck  --预检通过--> probing
probing   --结果--> {redeemed | already_owned | invalid | used | expired | region_blocked | needs_human}
probing   --成功且无异常--> redeeming            (试探通过后继续本批其余条目，仍串行)
redeeming --成功 + 库校验通过--> redeemed
redeeming --成功 + 库校验不中--> needs_human
任一状态  --人机校验 / 2FA / 陌生页 / 会话失效--> needs_human(暂停整批)
needs_human --人工解决--> precheck                (对同一 item 重跑；重快照不重放)
```

**会话失效语义（`#11`）**：`unauthorized` / `invalid_account` 命中 → **中止整批**（不继续消耗后续码），置 `needs_human`，重登后**从头重跑**该 item 的预检。

### 6.3 错误码 → 状态映射（主键为错误码，文案兜底）

| 状态 | 命中的 `errors.com.epicgames.*` 码（`#18` §1） |
|---|---|
| `invalid` | `coderedemption.code_not_found`、`invalid_code`、`invalid_code_status`、`code_not_active`、`code_required`、`invalid_code_criteria` |
| `used` | `coderedemption.code_used`、`multiple_redemptions_not_allowed`、`code_use_expired`、`code_use_not_found`、`codeUse_already_used`、`account_not_allowed_redeem`、`ecommerce.fulfillment.reach_offer_redemption_limit` |
| `expired` | `coderedemption.code_expired` |
| `already_owned` | `coderedemption.product_owned`、`criteria.content_already_owned`、`criteria.content_partial_owned` |
| `region_blocked` | `coderedemption.region_not_allowed_redeem`、`ecommerce.fulfillment.offer_region_blocked`、`ecommerce.fraud.geo_locked_redemption` |
| `needs_human` | `coderedemption.unsupported_namespace`（去别处兑换）、`criteria.missing_entitlement`、`account_redemption_meet_limit`、`batch_not_found`、`client_not_allowed_redeem`、`criteria.reject`、`reject_on_fraud`、`ecommerce.fulfillment.cabined_mode_account_blocked`、`ecommerce.subscription.platform_conflict`、`common.throttled`、`unauthorized` |
| **兜底** | **任何未列出的码 → `needs_human`**（不猜测、不重试） |

`needs_human` 命中风控（`reject_on_fraud`）或会话失效时，**暂停整批 + 指数退避**，不自动续跑。

---

## 7. 人在环路暂停点（一等公民）

| 暂停点 | 触发 | 处置 |
|---|---|---|
| 首次登录 | 无 Epic 会话 | 弹出可见窗口交人登录；完成后重快照 |
| 2FA | 约 30 天/新设备/清 cookie（`#18` §4） | 交人输入 TOTP/邮件码/backup code |
| hCaptcha / Turnstile / reCAPTCHA | 登录或兑换页命中 | 交人完成；**不尝试绕过**（ADR-0001） |
| 陌生页面 / 未知分支 | 出现未登记的结构 | 暂停 → 抓快照 → 代理离线产脚本 → 人审/预检后热替换 |
| **EULA / 额外确认** | Confirm 步骤要求同意条款 | 同意属**面向人且不可逆**的动作 → 首次出现时交人确认可继续自动处理（见 `#10` 的清醒取舍），并在台账留痕 |
| 重试耗尽 / 脚本疑似失效 | 有限重试仍失败 | 入「需人工」队列 |
| 会话失效 | `unauthorized` / `invalid_account` | **中止整批**，重登后重跑 |

窗口**默认可见、可随时接管**（`#7`）；`needs_human` 在 UI 上必须有显式入口，不是错误弹窗。

---

## 8. 半自动优先的落地

- **能走接口就走接口**：Humble 侧只读同步走 `GET /api/v1/*`；兑换面没有官方接口，全程走内嵌浏览器。
- **不可逆前**：确定性预检 + **单条试探**（先提交 1 条观察真实反馈，再继续），把爆炸半径压到一条码。
- **串行单条 + 人类节奏**：不做批量并发（Humble `robots.txt` / ToS + Epic 风控，`#18` §4）。
- **失败有限重试** → 入「需人工」队列，不无限重试。
- **日志脱敏**（`#10`），但**整页发代理不过滤**（key 明文上行是清醒选择）。

---

## 9. 不做（YAGNI）

- 不做「claim 领取」分支；不做多商店适配器抽象（第二家商店出现再说）。
- 不做兑换的无人值守批量并发。
- 不做纯 API 客户端（已被 ADR-0001/`#2`/`#6` 证伪）。
- 不申请 Epic OAuth API token / 不逆向未公开 JSON 端点（灰色地带，收益不抵风险）。
- 不做 Linux Launcher 集成（官方不支持）。

---

## 10. 回灌与残差

- **回灌 `#13`**：代理工具不包含 `reveal_key`/`redeem_code`/`open_store_page` 等运行时写操作；工具面＝观察 + 台账只读 + 写扩展 + `ask_human`。
- **回灌 `#14`**：兑换是否进 v1 由「v1 交付切片」票定；本票只保证「若做，就按此形态」。
- **回灌 `#10`**：EULA/确认同意属需明确告知的敏感动作。
- **回灌 ADR-0001/0002**：兑换页与 My Library 都必须在补了 client hints 的 store session 上访问。
- **HITL 残差**：① Fab profile → Redeem Code 的确切 href；② 账号兑换页实际渲染文案与错误码的对照；③ 登录态下一次真实 claim 是否全程无 challenge（`#16` 残差）。均列入 `#14` 的首次登录 checklist。
