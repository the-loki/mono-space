/**
 * 内置任务的提示词（ADR-0003）。
 *
 * 为什么放主进程：提示词与**输出 schema**都内置在应用侧。渲染层只传标识
 * （订单 gamekey / keyId），不拼提示词——界面改版不会悄悄改掉 agent 的纪律，
 * 也不会把「输出 schema」散落到两个进程（schema 在 `tools.ts` 的 `keys_ingest`
 * 与 `key_redeem` 里）。
 *
 * 三个任务都沿用同一套纪律：简体中文作答、只点一次、认不出就交人工、不用接口取码。
 */

/** 按订单读取全部 key 并揭示的内置任务提示词。 */
export function readOrderKeysPrompt(orderGamekey: string): string {
  return [
    `请读取订单 ${orderGamekey} 的全部 key 并落库，然后把本单仍未揭示的行逐条揭示。`,
    '两个阶段**先后有序：先落库、再揭示**——页面已经打开了，揭示就着**同一个页面**做，**不要重新打开**；',
    '阶段一·读取并落库：',
    `1) monospace_page_open 打开 https://www.humblebundle.com/downloads?key=${orderGamekey} ；`,
    '2) monospace_dom 看清页面（页面大时用 monospace_script 逐行取文本）；',
    '3) 逐条读出每一行：资产显示名 + 是否已揭示（已揭示连密钥一起读）+ **这一行自己的「Redemption Instructions」链接** + **这一行的平台**；',
    '4) monospace_keys_ingest 落库：orderGamekey 用上面的 gamekey、productName 用页面上看到的订单名，',
    '   每条 key 必须带它自己的 redemptionUrl，并给出它自己的 platform；',
    '   平台**由你在页面上逐行判断**：取值只能是台账既有的平台名（fab / epic / steam / unity / gog），',
    '   判不出来就写 unknown（界面上显示「未知」）—— **不许编**；',
    '   **同一订单页可能混排多个平台，逐行判断**：每一行看它自己的「Redemption Instructions」链接以及该行文案，',
    '   **不要假设「一页一平台」**（同一次订单里 Epic 与 Unity 并存是实测过的）；',
    '   **这一行确实没有兑换链接时，就写「无」** —— 不要把页脚、页面别处或其它订单的链接拿来充数，',
    '   宁可把这一行平台写成 unknown，也不许编（编出来的平台看起来像真数据，比 unknown 危险得多）；',
    '   每一行**拿不到兑换码**时必须给出无码缘由 noCodeReason（**有码的行就不用给**）：',
    '   页面写「此密钥已过期,不能再兑换」→ expired（已过期）；',
    '   点揭示后页面回「本产品密钥暂时耗尽 / 该产品密钥暂时已用尽」→ exhausted（发行方缺货）；',
    '   只能去第三方商店凭链接领取、页面没有密钥栏 / 揭示控件 → link_only（仅外部链接）；',
    '   判不出来写 unknown（原因不明）—— **不要编**；',
    '   **页面上没有 key 的订单**（音乐 / 电子书下载包之类）也要落库：给出 productName、keys 传空数组；',
    '阶段二·揭示本单仍未揭示的行（紧接阶段一，就在**同一个页面**上，**不要重新打开**）：',
    `5) 先查清哪些行**仍未揭示**：monospace_ledger_query({view:'unrevealed', orderRemoteId:'${orderGamekey}'})，`,
    '   从中拿到这些行的 keyId —— **只处理仍未揭示的行；已揭示的码在落库阶段已经拿到，不要碰它们**；',
    '6) 在页面上找到这些行各自的揭示控件（未揭示时文字为「显示您的 … 密钥」），逐行 monospace_act(click) 点它；',
    '   揭示**不可逆**，**每行只点一次**；',
    '7) 点完从**页面**读出密钥，用 monospace_keys_upsert 写回台账：每条带 keyId + code + revealed:true；',
    '8) 只回复结果摘要（写入几条、揭示几条）或失败原因。',
    '纪律（**两个阶段都适用**）：**只用简体中文作答，一个英文词都不要出现**；**不要用接口取码**（应用会在你落库后自己用接口补缺口，且以页面为准）；',
    '认不出某行的揭示控件、或点完读不到码时，**停下来报告交人工**，不要猜、不要重放；',
    '认不出某一行、或页面结构与预期不符时**交人工**，不要猜着写；落库只做一次，不要重复写；**绝不猜着点、绝不重放点击**。',
  ].join('\n')
}

/** 揭示单条 key 的内置任务提示词（不可逆，纪律写死）。 */
export function revealKeyPrompt(keyId: number): string {
  return [
    `请揭示台账里 keyId=${keyId} 的这条 key。`,
    '步骤：',
    `1) monospace_key_open({keyId:${keyId}}) 打开它所属订单的专属页；`,
    '2) monospace_dom 看清页面，找到这条 key 的揭示控件（未揭示时文字为「显示您的 … 密钥」）；',
    '3) monospace_act(click) 点它 —— **不可逆，只点一次**；',
    '4) 从页面读出密钥，用 monospace_keys_upsert 写回台账（keyId + code + revealed:true）；',
    '5) 只回复「已写入 <密钥>」或失败原因。',
    '纪律：**只用简体中文作答，一个英文词都不要出现**；**不要用接口取码**；',
    '认不出控件就停下来交人工，**绝不猜着点**、也**绝不重放点击**。',
  ].join('\n')
}

/**
 * 兑换单条 key 的内置任务提示词（代理驱动：提交在页面上由你做，工具只登记结果）。
 *
 * 与揭示的差别：兑换要先把码拿到（必要时先揭示），再按那一行自己的兑换指引
 * 到对应商店的页面上用**页面自己的控件**提交，最后把**页面读到的结果**登记回台账。
 */
export function redeemKeyPrompt(keyId: number): string {
  return [
    `请兑换台账里 keyId=${keyId} 的这条 key。提交兑换**不可逆**，整条流程**只提交一次**。`,
    '步骤：',
    `1) monospace_key_context({keyId:${keyId}}) 取这条 key 的上下文（名称 / 包 / 订单 / 揭示与兑换状态）；`,
    '   注意：它**不含兑换码明文**（除非显式要 code），也**不含兑换链接**——链接要去页面上读；',
    `2) monospace_key_open({keyId:${keyId}}) 打开它所属订单的专属页；`,
    '3) monospace_dom 看清页面，找到这条 key 那一行：',
    '   若**尚未揭示**，先用**页面自己的**揭示控件揭示（未揭示时文字为「显示您的 … 密钥」），**只点一次**，再从页面读出码；',
    '   已经揭示就直接从页面读出码；**不要用接口取码**；',
    '   拿不到码时（页面写「此密钥已过期,不能再兑换」/「本产品密钥暂时耗尽 / 该产品密钥暂时已用尽」，或只有第三方商店链接），',
    '   用 monospace_keys_upsert 带 noCodeReason 写回这一行的缘由：expired / exhausted / link_only / unknown；',
    '   **有码就不用给**，**判不出来写 unknown、不要编**；',
    '4) 在**同一行**读它自己的「Redemption Instructions」链接，据此判断该去哪家商店兑换（Epic / Fab / Steam 等各有自己的流程与页面）；',
    '5) 打开那家商店的兑换页（Epic 是 https://www.epicgames.com/account/code-redemption ），',
    '   用**页面自己的控件**填码并提交——**只提交一次**；',
    '6) **从页面读出结果**（成功，或页面上的错误原文照读，不要翻译、不要臆测）；',
    `7) 用 monospace_key_redeem({keyId:${keyId}, status, note}) 把结果**登记**进台账：`,
    '   status 只能取台账已有的兑换状态词（redeemed / already_owned / invalid / used / expired / region_blocked / needs_human 等），',
    '   note 写你在页面上看到的原文；**这是登记，不会替你提交**；',
    '8) 只回复结果摘要或失败原因。',
    '纪律：提交**不可逆**，**只提交一次**；',
    '遇到验证码 / 需要确认条款 / 认不出页面结构或读不出结果时，**停下来报告交人工，绝不猜、绝不重放提交**；',
    '**只用简体中文作答，一个英文词都不要出现**；**不要用接口取码**。',
  ].join('\n')
}
