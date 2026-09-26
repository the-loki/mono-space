---
status: accepted
---

# Store session 出网统一补齐 `Sec-CH-UA` 客户端提示

Electron 自带的 Chromium **默认在网络上完全不发送 `Sec-CH-UA` 家族客户端提示**（`sec-ch-ua` / `-platform` / `-mobile` / 高熵提示全无），即使服务端下发 `Accept-CH` opt-in 也不发；而渲染进程的 `navigator.userAgentData` 却存在。这构成「网络层 UA-CH 为空 ↔ JS 可见 UA-CH 存在」的实质分叉，是 Cloudflare 把默认 Electron 判为可疑并返回 `403 cf-mitigated: challenge` 的可观测根因。

实测（`#16`，2026-09-26，Ubuntu 26.04.1 / Electron 44.4.5，交替 A/B、独立 `persist:` 分区、同一出口 IP）：默认配置访问 `fab.com` / `epicgames.com/account/code-redemption` **0/4 通过**；在 `session.webRequest.onBeforeSendHeaders` 注入 `sec-ch-ua` 后 **4/4 通过**，`/i/users/me` 从 403 challenge 变为正常的 `401 {"detail":"身份认证信息未提供。"}`。只覆盖 `session.setUserAgent()` 为纯 Chrome UA **仍被 challenge**，且制造 UA↔UA-CH 分叉。

因此决定：**所有与 store（Humble / Fab / Epic）通信的 session，出网必须由 session 级中间件统一补齐 `sec-ch-ua` 家族头**；不靠散落各处的 `fetch` 头、不靠 `setUserAgent()` 伪装。UA 串本身保留 Electron 默认（不做伪装）——决定变量是 client hints 的在/缺，不是 UA 串。

## Considered Options

- **只改 `setUserAgent()` 成纯 Chrome UA**——实测无效（仍 403），且让 `navigator.userAgentData` 与实际 UA 分叉，是可被 JS 检测的新指纹。排除。
- **依赖 `--enable-features=UserAgentClientHint` 等开关让 Electron 自动发**——实测三组 feature flag 均无效。排除。
- **在每个请求处手写头**——易漏、易分叉；session 级统一注入是更深的模块边界。排除散写。
- **改用 Patchright / 自托管浏览器**——不在本轮范围；只有当**登录态写操作**仍被拦时才评估（`#16` HITL 残差）。

## Consequences

- 应用需要一个 **store session 工厂**：创建 `persist:` 分区的同时装上 client-hints 注入中间件；所有页面导航与该 session 的请求自动受益（含代理生成的扩展经该 session 发出的请求）。
- **登录态是否仍需补 CH、以及补充后 `cf_clearance` 的存活期，未验证**（`#16` HITL 残差）；首次人工登录时回填。
- 这是**与出口 IP 无关**的确定性修复；「默认必被 challenge」的结论在住宅 IP 下可能被高估，但修复方向不变。
- 与 ADR-0001 一致并**强化**它：主方案仍是「Electron 自带 Chromium + 私有 `persist:` 会话」，本条只是其实现义务。

证据见 `docs/verify/16-embedded-browser.md`（票据 `#16`）。
