# 兑换扩展（校准清单）

内容脚本只做页面交互，结果原样回执；归类在主进程（`parse-report.ts` + `status.ts`）。

## ⚠️ 首次人工登录时必须校准的选择器

`content.js` 顶部的 `SELECTORS` 每条给了多个候选，**未在真实 DOM 上验证过**：

| 键 | 用途 | 校准方法 |
| --- | --- | --- |
| `loggedIn` | 判定是否已登录 Epic | 登录后看顶栏账号菜单的真实选择器 |
| `codeInput` | 兑换码输入框 | 打开 `epicgames.com/account/code-redemption` 看输入框 |
| `redeemButton` | 「Redeem」按钮 | 同上 |
| `confirmButton` | 二次确认 / EULA 同意 | 提交后看是否出现确认步骤 |
| `resultArea` | 结果区（码/文案） | 故意提交一个错码，看错误 DOM 结构 |
| `captcha` | 人机校验 | 出现 reCAPTCHA / Turnstile 时的容器 |
| 库页 listing | `fab.com/library` 的卡片容器 | 打开库页看卡片结构 |

**对照 `#18`**：错误码优先从 `data-error-code` / `data-code` 读；读不到才用文案兜底
（`status.ts` 的 `classifyMessage`）。若真实页面既无属性、文案又与 `#18` 的 26 条不对应，
**必须回填 `docs/verify/18-…`**，而不是放宽归类。
