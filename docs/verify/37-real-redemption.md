# 验证 37：兑换端到端真机跑通（代理驱动，消耗真实密钥）

对应 `#27` 的 HITL 残差「单条兑换端到端」，也是 ADR-0005（兑换改代理驱动）落地后的**首次真跑**。
用户授权原话：「**都可以牺牲**」。

## 0. 结论先行

**跑通了，而且是完整的用户路径**：界面点那一行的「兑换」按钮 → 内置 agent 打开订单页 →
**从页面读到该行密钥** → 判断平台（读到该行的 Redemption Instructions 指向 Epic）→ 打开 Epic 兑换页 →
过掉账号切换页 → 在已登录的兑换表单里**只提交一次** → 读回页面结果 → 登记进台账。

| 项 | 值 |
| --- | --- |
| 目标 | `key id=197`「Astronauts (Pack)」（订单 `TfCt8vyzpzeG3VPP`，平台 epic，已揭示，码长 23） |
| 跑之前 | `redeem_status = not_redeemed` |
| 跑之后 | **`redeem_status = already_owned`**（页面原文：「你已经拥有此产品，故无法兑换此代码。」） |
| 耗时 | 17:22:23 点按钮 → 17:23:57 任务空闲，约 **94 秒** |
| 调试日志 | 10 条 → 37 条（全程可回看） |
| 密钥结局 | **没被消耗**：Epic 的语义是「已拥有 ⇒ 不能兑换此码」，码仍有效（这次授权没有真的烧掉一条码） |

**审计留痕**（`~/.config/mono-space/mcp-audit.jsonl`，逐字）——注意它**不含密钥明文**：

```json
{"at":"2026-09-27T09:23:48.244Z","tool":"key_redeem","keyIds":[197],"written":1,
 "detail":{"status":"already_owned",
           "note":"页面原文：「你已经拥有此产品，故无法兑换此代码。」（Epic 兑换页，提交后显示；另见「兑换您的代码时出现问题」）"}}
```

## 1. agent 的实际动作序列（来自调试窗，逐步）

```
monospace_script   → 扫该单页面上的行/指令，找目标行
monospace_script   → 读出该行密钥（脚本里带的是页面原文，不是代码侧猜的）
回合文本           → 「已从页面读到该行密钥。该行「Redemption Instructions」指向 Epic Games 兑换说明，
                       平台判为 epic。现在打开 Epic 兑换页。」
monospace_page_open→ https://www.epicgames.com/account/code-redemption
                     （**被重定向到** /id/login/switch-account?… —— Epic 的账号切换页）
monospace_act      → click uid=1_6（在切换页上选择账号）
monospace_script   → 读 { url, body.innerText }
回合文本           → 「已进入兑换码页面（已登录账户）。」
monospace_dom      → 「找到输入框。页面已登录，兑换表单就绪。」
（提交一次）
回合文本           → 「填入页面读到的密钥并提交（仅一次）。」
monospace_key_redeem → 登记 status=already_owned + 页面原文
```

**值得记下的两点行为**：
1. **先读页面再行动**：平台不是代码解析出来的（ADR-0006 后应用侧没有解析路径），是 agent 读到那行的
   「Redemption Instructions」指向 Epic 才判的 —— 与 ADR-0006 一致。
2. **重定向不等于失败**：Epic 把兑换页重定向到账号切换页，agent 没有当成「登录墙」就放弃，
   而是在**用户自己的会话里**过掉它。这也**推翻了我当时的即时判断**（我在 `tab list` 里看到
   `switch-account` 就下结论「Epic cookie 过期、未登录」并写进了汇报 —— 那是错的：
   浏览器里本来就该有用户已登录的账号，切换页只是中间一跳）。

## 2. 真实数据打出来的两个界面缺口（已修）

真跑得到 `already_owned` 之后，回看界面发现：

| 缺口 | 表现 | 修法 |
| --- | --- | --- |
| 配色分支漏了 `already_owned` | 落到 `default` ⇒ **灰色**（像个「未知」状态） | 与 `redeemed` 同色（绿）：`docs/spec/12` §6 明确「已拥有**视同成功**」 |
| 终态判定只认 `redeemed` | 已拥有的行**仍然显示「兑换」按钮** ⇒ 再点就是拿一条有效的码去撞一个已知结论 | `actionFor` 把 `already_owned` 也算终态（不给动作） |

两处都不是从代码里想出来的，是**真数据摆到界面上了才看见**。e2e 新增一条钉住：
已拥有的行显示「已拥有」、**没有**动作按钮；同时断言普通「未兑换」行**仍有**按钮
（防止把终态判定改宽）。

## 3. 一条要说清的边界（日志可见性）

调试窗的**工具参数**里会出现密钥明文（agent 要读它、提交它，脚本载荷自然带着它）。
本次实测：

- **不落盘**：日志是内存环形缓冲（500 条，新任务开始清空），不写文件；退出即没。
- **审计文件里没有明文**：`key_redeem` 记录的是 status + 页面原文（见上），不含码。
- 也就是说「日志脱敏」（`#10`）在**持久化**这一维度是成立的；屏幕上给用户看自己账号的码，
  属于「用户自己的界面」，本次不改（要做模糊化就会开始藏真信息，代价大于收益）。

## 4. 仍未验的（诚实边界）

- **揭示拿到新码**：`docs/verify/34`/`35` 已把能点的都点了，真实库没有「能出码」的未揭示行 ——
  「点得动」验过 34 单，「点得出码」仍未验（需等有新的可揭示订单）。
- Epic 的 `/i/users/me` 200、一次真实 claim 全程无 challenge、Epic 2FA 方法 —— 仍未验（本次只到兑换页）。
- 兑换的其它终态（`invalid` / `used` / `region_blocked` / `needs_human`）没有真实样本；
  这次只观测到 `already_owned` 一种。

## 5. 复现方式

```bash
# 真跑（会消耗真实密钥；界面路径：订单明细 → 那一行的「兑换」）
DISPLAY=:0 electron . --no-sandbox
#   然后看调试窗（工具条上的「调试日志…」）逐步动作，结束后查台账与审计：
sqlite3 ~/.config/mono-space/ledger.sqlite "select id,name,redeem_status,redeemed_at from keys where id=197"
tail -3 ~/.config/mono-space/mcp-audit.jsonl
```

驱动脚本 `/tmp/verify-redeem.sh` 是临时脚本、**未入库**（流程就是上面那两步的手动等价）。
