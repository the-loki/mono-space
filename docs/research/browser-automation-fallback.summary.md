研究完成（仅 Linux 前提，目标场景 Epic Fab）→ 分支 `research/browser-automation-fallback`，文件 `docs/research/browser-automation-fallback.md`（705 行）

**结论：主方案 = Electron `WebContentsView` + 应用私有 `session.fromPartition('persist:…')` 分区 + Electron 原生/CDP 驱动（`executeJavaScript` / `debugger` / `Input.*`）。不内嵌第二套 Chromium，不用「外接系统浏览器 + 调试端口」。**
- 外接方案已排除：Chrome 136 起 `--remote-debugging-port` 在默认 profile 上失效，必须配 `--user-data-dir` → 只能是空 profile，「复用已登录态」不成立。
- 登录态：`persist:` 数据落在 `<userData>/Partitions/<escape(lower(name))>/`（源码级事实）；用 `ses.getStoragePath()` 查、`cookies.flushStore()` 强制落盘（默认 30s/512 次操作）。Linux 无 keyring 时 cookie 只是混淆（`--password-store=basic`）。
- Fab 实测：Cloudflare 前置（裸 curl `403 cf-mitigated: challenge`，补 `sec-ch-ua`/`sec-fetch-*` 即 200）、站点加载 hCaptcha（`render=explicit`）、SPA 走 `/i/*`（`/i/users/me` 为登录态探针）。
- 表示层：a11y 树为主（CDP `Accessibility.getFullAXTree` ≙ `ariaSnapshot({mode:'ai'})`）+ 定向 DOM + 截图兜底。复用 Stagehand（TS/MIT/`cdpUrl` 一等）或 Playwright MCP（Apache-2.0/可 spawn）；browser-use 是 Python 需 sidecar 且靠云端解盾，与本项目「交人工」立场相反。
- 人工兜底：显式状态机 + 三级完成信号（页内工具条 IPC / 站点探针 / 导航稳定）+ 恢复时**重快照不重放**；Cloudflare/hCaptcha 一律交人工。Wayland：不靠 `setPosition`/抢焦点，视图内 `setBounds` 与 CDP `Input.*` 不受限。Patchright（4,680★/Apache-2.0/2026-09-13）仅作退路；Skyvern/lightpanda 为 AGPL，勿静态链接。
- **未验证项 14 项**（§10）：最关键是 `connectOverCDP` 能否驱动 Electron 目标、Electron 内置 Chromium 在 Fab 全程是否被放行、UA/UA-CH 不一致的实际后果。
