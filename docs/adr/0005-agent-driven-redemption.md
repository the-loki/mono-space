---
status: accepted
---

# 兑换改为代理驱动，删除代码驱动的兑换栈

用户决策（2026-09-27）：

> 「**移除纯代码驱动的逻辑，我希望的是代理驱动**」

前情：揭示在 `#27` 已改为**代理驱动**——agent 用浏览器工具操作页面自己的控件，
代码里不再有特征匹配（见 ADR-0003 与 `agent/prompts.ts`）。兑换则一直留在**代码驱动**：
主进程装载一个内置 MV3 扩展（`src/main/redeem/extension/content.js`），扩展在页面里用
写死的 `data-testid` / CSS 选择器填码、点 Redeem、点 Confirm，用**按钮文案正则**与
**整页 `innerText` 正则**判断成败；主进程侧再用 `status.ts` 的错误码表归类、用
`library-check.ts` 的**标题模糊匹配**校验 Fab 库。这条栈按 `#12` / `#26` 的
「日常执行全程确定性代码 + 扩展，运行期不过模型」落地。

用户在一次确认中知悉「兑换是不可逆消耗，改成 agent 判断后，判据会从可复现的代码
变成模型判断」，仍然明确要求移除代码驱动、改成与揭示同构的代理驱动。本 ADR 记录这次
**推翻**。

## 为什么

1. **选择器与正则都是脆的**。`data-testid`、按钮文案正则、整页 `innerText` 正则、
   标题模糊匹配，任何一处页面改版都会静默失效——而兑换**不可逆**，失效的代价是一条
   码被错误提交或被错误地记为成功。可复现不等于可靠：一份写死的假设会一直以「可复现」
   的样子错下去。
2. **页面是唯一真源，判断也该在页面上做**。兑换的结果（成功 / 已拥有 / 无效 / 已用 /
   区域受限 / 需人工）本来就写在页面上；让代码隔着扩展去猜，不如让**能看见整页**的
   agent 读原文。这与 ADR-0003「页面才是权威」一致。
3. **用户明确要代理驱动**：揭示已经证明 agent 能用 `monospace_dom` + `monospace_act`
   操作页面自己的控件；兑换没有理由例外。

## 被移除的东西

- **整个代码驱动兑换栈**：`src/main/redeem/**`（编排 `flow`、状态机 `machine`、错误码表
  `status`、页面驱动 `page-driver`、回执解析 `parse-report`、库校验 `library-check`、
  命令通道 `channel`，以及 8 个测试文件与页面扩展 `extension/`）。
- **只服务这个扩展的基建**：`browser/bundled-extensions.ts`、`browser/extension-path.ts`
  与 `electron-builder.yml` 里把扩展复制进 `extraResources` 的条目。
- **`tasks:redeem` 通道**（IPC / preload / 契约 / UI 调用）与 `runRedeem`。
- **页面里的 `data-testid` 选择器、按钮文案正则、整页 `innerText` 正则、标题模糊匹配**。
- `monospace_key_redeem` 的旧宿主实现（调 `runRedeem`）。

**保留**：`tasks:login`——登录是**人**要做的动作（2FA / 验证码），与本次无关。

> 未删的一项：`browser/extension-host.ts`（MV3 扩展装载 / 热替换）与
> `tests/fixtures/extension-mv3*/**`。它们不是兑换专用——`tests/e2e/browser-skeleton.spec.ts`
> 用它们证明「Electron 内嵌会话能装 MV3 扩展并经桥上报」，那是通用能力测试。
> 删除会破坏 e2e（e2e 不许改），故保留，并在删除任务里单列。

## 新的形态（与揭示同构）

1. `agent/prompts.ts` 新增 `redeemKeyPrompt(keyId)`：`monospace_key_open` 打开订单页 →
   必要时先按页面自己的控件揭示拿码 → 读那一行自己的「Redemption Instructions」链接 →
   到对应商店的兑换页用**页面自己的控件**填码、提交 → **从页面读出结果** →
   `monospace_key_redeem` 登记回台账。
2. `monospace_key_redeem({ keyId, status, note? })` 从「执行兑换」变成「**登记**结果」：
   它走仓储 `setRedeemStatus` 并**强制留痕**，**不会替调用方提交任何东西**。
   `status` 只复用台账已有的兑换状态词汇（`REDEEM_STATUSES`），不发明新值。

## 层级选择：`key_redeem` 从 L2 降到 L1

旧实现里它调 `runRedeem`，**宿主自己执行不可逆动作**，所以在 L2（`AGENT_DENIED_LAYERS`）。
这带来一个死结：不可逆动作改到页面上由 agent 完成后，agent 必须能把结果写回台账，
而 L2 的工具**根本不会注入给模型**——留在 L2 等于这件事没做。

分层语义（`#13`）本来是按「动作性质」分的：L0 只读、L1 写入留痕、L2 宿主侧不可逆。
现在的 `key_redeem` 只是**写一行状态 + 留痕**，与 `keys_upsert` 同类，因此归 **L1**。
**L2 的门保留**（`AGENT_DENIED_LAYERS = ['L2']` 不动）：将来若再出现「宿主侧自己执行
不可逆动作」的工具，仍然默认不给模型。

## 代价（清醒取舍）

- **判据从可复现代码变成模型判断**。旧栈的归类是纯函数 + 一张错误码表，可单测、可复现；
  新栈的判据是模型看着页面下的结论。**不可复现**是这次改变的核心代价，用户已知悉。
- **不可逆动作的纪律只能靠提示词与审计**。没有代码能拦住「提交两次」；能做的只有
  在提示词里写死「提交不可逆、只提交一次、认不出就停下交人工、绝不重放提交」，
  并用审计（`key_redeem` 落一行 JSONL）在事后可核对。
- **错误码表不再是执行路径**。`docs/verify/18` 的 26 条错误码从「归类主键」退为
  **参考材料**（供 agent 读懂页面原文），不再有代码引用它。

## Consequences

- `monospace_key_context` 只给**名称 / 包 / 订单 / 揭示与兑换状态**，**不含码明文**
  （除非显式 `includeCode`），也**不含兑换链接**——所以提示词要求 agent 到**页面上**读
  那一行的兑换指引链接，而不是替它假设一个 URL。
- 兑换与揭示现在**同构**：都由 agent 操作页面自己的控件，都用 `keys_upsert` /
  `key_redeem` 写回台账，都遵守同一套中文纪律。
- 旧栈的测试随模块一起删除；`monospace_key_redeem` 的新语义（登记 + 审计 + 状态词收敛）
  由 `agent/__tests__/host-ledger.test.ts` 与 `tools.test.ts` 钉住。
