---
status: accepted
---

# 台账的 key 与资产包只从页面读取，接口仅提供订单

用户决策（2026-09-26，连续两次明确）：

> 「接口获取订单，其它走页面」
> 「资产包也由页面承担」

前情：此前的台账**完全由接口同步建立**。`runSync` 拉订单列表，再对每单请求
`GET /api/v1/order/<gamekey>?all_tpkds=true`，从响应里一次性取出 **952 个 key**
（`tpk_dict.all_tpks` 里带 `machine_name` / `keyindex` / `redeemed_key_val`），
再经 `mapOrder` 交给 `repository.applyOrderSync` 落库成 order → bundle → key 三层。

这带来三个问题：

1. **key 明文来自接口**。同步其实把 `redeemed_key_val` 丢了（只用它的布尔值判揭示状态），
   但「接口里带着码」这件事本身就是错的取码途径——用户的红线是「不准通过 api 请求具体的 key」。
2. **页面成了接口的影子**。真正权威的是 Humble 页面上显示给用户的东西；走接口意味着页面结构
   一变、或者接口字段语义一变，台账就悄悄错，而没人会知道。
3. **快得可疑**。69 个请求 ~10 秒就拉完 952 个 key；这种「快」正说明它没在被授权的那条路上。

因此决定：

- **接口只做两件事**：取**订单列表**（哪些订单/gamekey 存在）与**核对/查缺口**。
  它**不再提供** key，也不再用订单详情里的 key。
- **key 与资产包（`engine_asset_bundles`）全部由页面读取**：agent 用浏览器逐单打开订单页
  （`/downloads?key=<gamekey>`），把这一单的资产分组、资产名、揭示状态与密钥读出来，再落库。

## Considered Options

- **保持接口同步（现状）**——被否：违反「不准通过 api 请求具体的 key」，且台账与页面可能静默分叉。
- **完全不要接口，页面当唯一来源**——被否：订单列表（有哪些单、哪些 gamekey）在页面上要翻
  48 页分页才能凑齐，且「Humble 侧到底有多少单」这个**缺口核对**没有独立来源可比。
  接口取订单列表正好补这一点。
- **接口给结构（含资产包分组）、页面只补码**——被否：资产包分组来自订单详情的
  `machine_name` 后缀（`_softwarebundle` / `_bookbundle` / `_unity`），既然要继续请求详情，
  就等于继续把 key 一起取回来，红线绕不过去。用户明确选了「资产包也由页面承担」。

## Consequences

- **同步管线要拆**：`HumbleClient` 只保留订单列表接口；`mapOrder` 不再产出 key，
  `applyOrderSync` 不再收到 key。订单详情请求（`?all_tpkds=true`）退出同步路径。
- **需要新的落库入口**：agent 从页面读到的「订单 → 资产包 → key」要能写进台账。
  复用现成的 `repository.upsertKey(bundleId, SyncedKey)`；`SyncedKey` 已支持
  `revealStatus` / `revealedAt` / `redeemCode`，够用。计划新增工具 `monospace_keys_ingest`。
- **key 身份要重新定义**：接口时代 `remoteId = <machine_name>#<keyindex>`，而页面上**没有机器名**
  （实测行文本只有资产显示名与码）。特征匹配删除后 `keytype` / `keyindex` 已不再被揭示流程需要，
  所以页面侧身份可以由资产显示名推导（slug + 同单内序号）。
- **空台账的起点问题**：`browserCurrentPage` 要求「页面先由界面打开」，`key_open(keyId)` 需要 keyId；
  台账为空时两者都不成立。需要一条「打开 Humble 密钥页/订单页」的入口（工具或界面），
  否则 agent 无法开场。
- **成本方向反转**：读 952 个 key 从「~10 秒」变成「逐单开页面、逐条读」——分钟到小时级。
  这是**为正确性付的价钱**，用户已明确接受（并反对过用接口兜底取码的「快」）。
- **核对语义变清晰**：接口答「Humble 侧有哪些订单」，页面答「这一单里到底有什么」，
  两边不一致就是**缺口**，交人工——而不是让接口直接充当答案。
- 与 ADR-0001 / 0002 不冲突：本条只管**数据来源**，不改浏览器与网络身份的既有决策。

证据与实测校准见 `docs/verify/19-v1-acceptance.md`（订单页真实 DOM、控件链、异步渲染）。

## 追加：平台（platform）**逐条判断**，不是每单一值

用户补充（2026-09-26）：

> 「有时候同一个订单页有多个平台的内容，需要 agent 判断」

同一张订单页里可能同时有多个平台的 key（例如一部分 Steam、一部分 Epic）。因此：

- **平台是 key 级属性**，不是订单级、也不是资产包级。`keys_ingest` 的每条 key **各自带 platform**。
- **判定依据是那一行自己的**「Redemption Instructions」链接，而不是页面级的某一个。实测该链接形如：

      https://support.humblebundle.com/hc/en-us/articles/360020257973-How-to-Redeem-on-Epic-Games#redeem
                                                                        ^^^^^^^^^^^^^^^^^^^^^^ → epic

  解析文章 slug 得到平台（`fab` / `epic` / `steam` / `unity` / `gog` …），认不出的一律 `未知`。
- **由 agent 逐行读、逐行判**：代码不做「一页取一次」的假设。页面结构允许混排，代码就无法替它判断。

这条同时说明了**为什么界面不该显示「引擎」**：引擎来自接口的 `machine_name` 后缀（`_fab` / `_unity`），
而页面读取的 key **没有 machine_name** —— 引擎在页面驱动下永远推不出来（只会是「未知引擎」）。
平台则相反：页面链接里就有，但**只有逐条读才拿得准**。
