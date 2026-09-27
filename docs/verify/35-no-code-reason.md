# 验证 35：无码缘由（拿不到码的行必须带缘由）

日期：2026-09-27。用户要求原话：「需要提示无码的缘由」。
起因：`docs/verify/34` 那次全量揭示暴露出 46 条未揭示的行**码一个也没拿到**，而界面只显示「未揭示」，
看不出是过期、缺货还是根本没有揭示控件 —— 用户无法判断「该等补货」还是「该人工处理」。

## 0. 结论先行

已实现并**在真实数据上端到端验证通过**：

```
真库迁移 v5 → v6：链条 1:initial-ledger → … → 6:keys-no-code-reason，keys 1087 条一条没丢
真跑一单（MbybRq46KPkFb2tT，页面 10 行写「此密钥已过期,不能再兑换」）：
  → 库里出现 10 行 no_code_reason='expired'（分布：{expired: 10}）
  → 明细界面出现 10 个「已过期」徽章（截图 /tmp/verify-ncr/detail-with-reason.png）
不变式 ★「有码且有缘由」= 0 行（写码时缘由被清空）—— 界面正是靠它判断「无码且已判定」
```

## 1. 取值与「谁来判断」

```
expired    已过期          页面写「此密钥已过期,不能再兑换」
exhausted  发行方缺货      点揭示后页面回「本产品密钥暂时耗尽 / 该产品密钥暂时已用尽」⇒ 等补货
link_only  仅外部链接      只能去第三方商店凭链接领取；页面没有密钥栏 / 揭示控件
unknown    原因不明        判不出来
```

**只有 agent 能给缘由**。本仓库明确删过「应用侧解析页面语义」的代码（平台三层回退，见 ADR-0006），
所以这次也不在应用侧写页面文案正则：应用只做**取值收敛**（`normalizeNoCodeReason`：trim + toLowerCase，
命中枚举才用，非空非法值落 `unknown`，空/非字符串落 `null`）—— **永远不抛错、不回滚整笔写入**
（本仓库教训：一行不合格曾导致整单回滚）。

## 2. 数据模型

- `keys.no_code_reason TEXT`（可空，逐行）。**NULL = 有码，或还没有判定过**。
- 迁移 v6 `keys-no-code-reason`；`INITIAL_SCHEMA_SQL` 保持冻结（与 platform 由 v2 加上同一套路）。
- **写码时清掉缘由**：`upsertKey` 的 UPDATE 用
  `no_code_reason = CASE WHEN COALESCE(?, redeem_code) IS NOT NULL THEN NULL ELSE COALESCE(?, no_code_reason) END`，
  `markRevealed` 也置 NULL。理由：有码的行留着过期缘由会误导，并会破坏上面那条界面依赖的不变式。
- 写入路径：`keys_ingest`（每条 key）、`keys_upsert`（每条 entry）都接受 `noCodeReason`；两者都过收敛函数。
- 占位符个数（本仓库所有语句过 `assertStatementArity`，只校验个数）：`upsertKey` UPDATE 11 → 13、
  INSERT 14 → 15、`markRevealed` 5 → 5（`NULL` 是字面量）。

## 3. 界面

明细新增独立一列 **「无码缘由」**，徽章只写缘由本身（`data-testid="key-no-code-reason"` + `data-reason` + `title`）。
配色：`expired` / `exhausted` → `badge-warn`（暂时无解、值得留意），`link_only` / `unknown` → `badge-muted`（中性）。
颜色只是辅助，含义由中文承载。

**为什么单占一列而不是塞进「揭示状态」格**：两者是不同轴（一个说「揭示走到哪一步」，一个说「为什么没码」）。
实现时先塞进 6rem 的「揭示状态」格，两个胶囊横向装不下、缘由徽章还带 `shrink-0`，会溢到相邻列 —— 独立成列后
可以竖向对齐，一眼可扫（这也是我推翻子任务那版实现的原因，它自己也如实上报了「改了但没把握」）。

## 4. 一条必须说清的语义边界

**缘由描述的是「页面上这一行为什么没有码」，不是「台账里完全没有这个资产的码」。**

实测 `MbybRq46KPkFb2tT`：10 行 `expired`（页面行无码）**同时**在**同一订单内**有同名、带码的
「接口补充行」（ADR-0004 的补充机制）。也就是说那一行的资产码其实已在台账里，
只是页面行因为从没出现过码、与补充行连不上（连接键是码）。
所以界面会同时出现：`未揭示` + `已过期`（这一行）+ 另一行 `已揭示`（补充行）。

要不要按资产名把这种重复行并掉，是 `docs/verify/34` §3 记录的**产品决策点**，本次不动。

## 5. 测试

- 新增 `src/main/data/__tests__/no-code-reason.test.ts`（收敛函数边界：大小写 / 空白 / 非法值 / null / 数字）。
- `migrate.test.ts` +3：v6 存在、空库跑完整链后 `PRAGMA table_info(keys)` 含该列、v5 库升 v6 不丢数据
  （并保住既有对 v5 的精确断言）。
- `repository.test.ts` +8：落库枚举、脏值收敛、空白落 null、**写码清缘由**（关键回归）、`markRevealed` 清缘由、
  重读更新、`setNoCodeReason` 兜底、列表投影仍不含 `redeem_code`。
- `page-ingest.test.ts` +4（透传 / 收敛 / 缺省 null / 有码不留）；`tools.test.ts` +5（两个 schema 可选 + 描述 + handler 收敛）；
  `prompts.test.ts` +2；`host-ledger.test.ts` +2；`tests/e2e/ledger.spec.ts` 加 fixture 一行 + 断言徽章出现/有码行不出现。
- 单测 **322 → 351**（29 → 30 文件），四处自查全绿（typecheck 0 错 / lint 干净 / 构建通过）。

## 6. 本次不做的（有理由的边界）

- **导出不带这一列**：导出目前**没有任何出口**（`docs/verify/33` §0 记录的已知问题：算完文本就被丢弃），
  加列还要动 `serialize.ts` 与 CSV 末列约定。已在 `LedgerKeyFieldName` 里显式排除并写明理由 —— 等导出修好再加。
- **不回溯历史数据**：库里既有的未揭示行缘由仍是 NULL（= 还没判定）。要填就得重跑那些单（真跑一单约 1–3 分钟）。
  本次只在真跑过的那一单上验证了效果（10 行 expired）。
- **不做兑换**（不可逆、消耗密钥）。

## 7. 过程里我自己的仪器故障（备案）

验证脚本里那个查库的辅助函数把参数传错，导致 **7 项检查打成空值、误报失败**（真库状态改用独立只读脚本
`/tmp/ncr-check.mjs` 复核后才下结论：迁移、分布、不变式全部成立）。凡是我自己写的检查脚本，
失败项都先归因到「仪器」还是「产品」才下结论 —— 这次 7 项全是仪器。
