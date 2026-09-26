/**
 * 内置任务的提示词（ADR-0003）。
 *
 * 为什么放主进程：提示词与**输出 schema**都内置在应用侧。渲染层只传标识
 * （订单 gamekey / keyId），不拼提示词——界面改版不会悄悄改掉 agent 的纪律，
 * 也不会把「输出 schema」散落到两个进程（schema 在 `tools.ts` 的 `keys_ingest` 里）。
 *
 * 两个任务都沿用同一套纪律：简体中文作答、只点一次、认不出就交人工、不用接口取码。
 */

/** 按订单读取全部 key 的内置任务提示词。 */
export function readOrderKeysPrompt(orderGamekey: string): string {
  return [
    `请读取订单 ${orderGamekey} 的全部 key 并落库。`,
    '步骤：',
    `1) monospace_page_open 打开 https://www.humblebundle.com/downloads?key=${orderGamekey} ；`,
    '2) monospace_dom 看清页面（页面大时用 monospace_script 逐行取文本）；',
    '3) 逐条读出每一行：资产显示名 + 是否已揭示（已揭示连密钥一起读）+ **这一行自己的「Redemption Instructions」链接**；',
    '4) monospace_keys_ingest 落库：orderGamekey 用上面的 gamekey、productName 用页面上看到的订单名，',
    '   每条 key 必须带它自己的 redemptionUrl（平台由应用解析，你不要自己判、也不要省）；',
    '5) 只回复结果摘要（写入几条）或失败原因。',
    '纪律：**只用简体中文作答，一个英文词都不要出现**；**不要用接口取码**（接口只提供订单列表）；',
    '认不出某一行、或页面结构与预期不符时**交人工**，不要猜着写；落库只做一次，不要重复写。',
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
