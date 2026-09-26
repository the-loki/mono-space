# Electron 内驱动「已登录」浏览器会话做自动化，并接入人工兜底

- **验证日期**：2026-09-26（UTC）
- **目标平台**：**仅 Linux**（X11 与 Wayland；Debian 12/13、Ubuntu 22.04 / 24.04 / 26.04 一类发行版）
- **目标场景**：操作**资产商店**，第一优先 **Epic Fab**（`www.fab.com`）
- **对应票据**：GitHub issue #6（`the-loki/mono-space`），Part of #1
- **标记约定**：
  - ✅ **已验证**：一手来源（官方文档 / 官方源码 / 本机实测）可直接支撑
  - 🟡 **推断**：有来源但未在目标环境实测，或由源码/文档推得
  - ❓ **未验证**：列入 §10「未能验证 / 开放问题」

> 本文只做「决策所需的事实 + 推荐」，不做实现。所有 API 名与调用方式都落到具体接口。

---

## 0. 结论先行（TL;DR）

1. **不要用「外接系统浏览器 + `--remote-debugging-port`」作为主方案。** Chrome 136 起该开关在**默认 profile 上不再生效**，必须同时给 `--user-data-dir`，于是你只能拿到一个**全新空 profile**——「复用用户日常已登录态」这个前提直接不成立。✅
2. **不要首选内嵌 Playwright / Patchright 另起一个 Chromium。** 那是第二套 Chromium 二进制（Electron 44 = Chromium 152.0.7977.130；Playwright 1.63.0 = 自带 Chromium build 1243），带来打包体积、版本分叉、以及「用户可见可接管」需要自己搭桥三个成本。✅🟡
3. **首选：Electron 自带 `WebContentsView` + 应用私有 `persist:` 分区 + Electron 原生 / CDP 驱动。** 登录态天然同源（同一个 `session`）、用户看着的就是同一个窗口、零额外 Chromium 体积；而且 `WebContentsView.setBounds()` 是**窗口内布局**，不受 Wayland「不能程序化定位窗口」的限制。✅🟡
4. **页面理解的表示：a11y（可访问性）树为主 + 截图兜底。** CDP `Accessibility.getFullAXTree`；Playwright 生态的等价物是 `locator.ariaSnapshot({ mode: 'ai' })`（带 `[ref=eN]` 引用）。这不是小众做法：Playwright MCP 官方定位就是「Uses Playwright's accessibility tree, not pixel-based input」。✅
5. **不自研 agent 框架。** 直接复用 Stagehand（TypeScript / MIT / 可跑在 Electron 主进程 / 支持 CDP connect）或 Playwright MCP（Apache-2.0 / Node 包 / 可被 spawn）；`browser-use` 是 Python，嵌 Electron 需要 sidecar 进程。✅
6. **人工兜底做成显式状态机 + 三级恢复信号。** Fab 上的 Cloudflare 与 hCaptcha 一律**交人工，不尝试自动过盾**。✅

---

## 1. 目标场景给方案的硬约束（先测后选）

选型必须服从 Fab 的实测形态，所以先把 Fab 测了。

### 1.1 Fab 一手实测

| 观察 | 结果 | 级别 |
|---|---|---|
| `curl -sIL https://www.fab.com/` | `HTTP/2 403`，`cf-mitigated: challenge`，`server: cloudflare`，带 `accept-ch` / `critical-ch: Sec-CH-UA-Bitness, Sec-CH-UA-Arch, …` | ✅ |
| `curl -sIL https://store.epicgames.com/en-US/` | 同样 `HTTP/2 403` + `cf-mitigated: challenge` | ✅ |
| 挑战页内容 | `cf_challenge_*`、`Enable JavaScript and cookies to continue`、`__cf_chl_opt.cType: 'managed'` | ✅ |
| 只加浏览器 UA | 仍 403 | ✅ |
| 只加 `-H 'sec-ch-ua: "Chromium";v="140"'` | **200** | ✅ |
| `sec-ch-ua` + `sec-ch-ua-mobile` | **200** | ✅ |
| 再加 `sec-ch-ua-platform`（三件套） | **403** | ✅ ⚠️ |
| 只加 `-H 'sec-fetch-dest: document'`（或 `sec-fetch-mode` / `sec-fetch-site`） | **200** | ✅ |
| 只加 `accept` / `accept-language` / `sec-ch-ua-platform` / `upgrade-insecure-requests` | 仍 403 | ✅ |
| 加 `accept` + `accept-language`（仍无 client hints） | 仍 403 | ✅ |
| 首页内联脚本 | 加载 `https://js.hcaptcha.com/1/api.js?render=explicit&uj=true` | ✅ |
| 内部 JSON 接口 | `/i/users/me`、`/i/taxonomy/listing-types`、`/i/layouts/homepage`、`/i/channels` | ✅ |
| 首屏体积 | 约 2.3 MB HTML（SSR + SPA） | ✅ |

> ⚠️ **对 bisect 结果的诚实说明**：单头替换的样本量很小，且 Cloudflare 的 managed challenge 是**有状态评分**（同 IP 连续请求间的结果不完全独立）。「三件套反而 403」这一格可能是噪声，也可能是 Cloudflare 在要求 client hints **互相一致**。→ **只把「缺失 client hints / Sec-Fetch 会被挑战」当可靠结论**，把「具体哪个头组合最优」当作 §10 #3 的实测任务。

**从实测得到的三个硬约束：**

1. **Cloudflare 的判定至少部分依赖 UA 客户端提示头（Sec-CH-UA\*）与 Sec-Fetch 头。** 这说明「真实 Chromium」这条路是通的（Electron / Playwright 默认都发这些头），而「伪装成浏览器的 HTTP 客户端」这条路不通。反过来说：**一旦人为改 UA 造成 UA 串与 Sec-CH-UA 不一致，很可能自己把自己送进挑战页**（见 §10 #3）。✅🟡
2. **Fab 自带 hCaptcha（`render=explicit`）。** 出现点需实测确认，但既然站点主动加载，就必须把「hCaptcha 出现 → 立刻交人工」当作一等公民流程。✅
3. **Fab 是 SPA 且走 `/i/*` JSON。** 好处是有一个天然的登录态探针与「完成」判定点：`/i/users/me`。✅

### 1.2 Fab 的兑换语义与游戏商店不同

Fab 是**资产商店**（Unreal / Sketchfab / Quixel / ArtStation 合并后的市场），不是游戏 key 商店：

- 没有「key 兑换页」，对应动作是**登录 Epic 账号 → 领取 / 购买（claim）→ 资产进入 Epic 账号库 → 通过 Epic Games Launcher 或 Fab Library 下载**。🟡
- 因此本项目的「自动化」实际是：**账号态 SPA 上的多步交互（筛选、claim、确认）**，而不是「把 key 提交给兑换表单」。这反而**降低了**方案的复杂度：不需要处理「一次性提交不可重放」的 key，失败可重试；但**抬高了**登录态与反自动化的权重，因为整条链路都在一个 Cloudflare + hCaptcha 的 SPA 里。
- 对方案选择的影响：**「同一份登录态」是第一优先级，「页面级决策」是第二优先级。** 这正好指向 Electron 自带 `session`（§2 方案 A）。

---

## 2. Q1 方案对比

四个候选（原票三个 + 一个现实中最常见的混合体）：

| | 方案 | 一句话 |
|---|---|---|
| **A** | Electron 自带视图 + 原生驱动 | `WebContentsView`（`BrowserView` 已弃用）+ `webContents.executeJavaScript` / `webContents.debugger`(CDP) / `sendInputEvent` |
| **B** | 内嵌 Playwright / Patchright 持久化上下文 | `chromium.launchPersistentContext(userDataDir)`，自己开一个 Chromium 窗口 |
| **C** | 外接系统浏览器 + 远程调试端口 | 用户自己的 Chrome/Chromium/Firefox + `--remote-debugging-port`，Playwright `connectOverCDP` |
| **D** | 混合：Electron 内置视图 + Playwright 从外部连自己的端口 | 视图由 Electron 管，驱动交给 Playwright（`connectOverCDP` 到自己的 `--remote-debugging-port`） |

### 2.1 四维对比

| 维度 | A：Electron 自带 + 原生驱动 | B：内嵌 Playwright/Patchright | C：外接系统浏览器 + 调试端口 | D：Electron 视图 + 外部 Playwright |
|---|---|---|---|---|
| **同一份登录态** | ✅ 最好。视图与 UI 共用一个 `session`（`persist:` 分区），`session.fromPartition()` 返回同一实例；cookie 天然共享，无需导出导入 | 🟡 好，但是**独立 profile**：`launchPersistentContext(userDataDir)` 的目录与应用自己的 `userData` 是两个世界，要自己保证「只登录一次」的是哪一个 | ❌ 最差。Chrome ≥136 拒绝在默认 profile 上开调试端口，必须 `--user-data-dir` → **空 profile，用户得重新登录一遍**；想复用日常态只能靠扩展 / 账号密码 | ✅ 同 A（登录态在 Electron 侧），Playwright 只是驱动 |
| **用户可见可接管** | ✅ 最好。视图就在自己的窗口里，用户点进去就能操作，无需切换应用；`.focus()` / `show()` 可控 | 🟡 可见（headful），但那是**另一个浏览器窗口/另一个应用**，与你的 UI 不在同一窗口，交接体验割裂 | ✅ 可见（就是用户自己的浏览器），但你**无法控制它的位置/层级**，且用户关掉标签页就断线 | ✅ 同 A |
| **打包体积** | ✅ 零额外。用 Electron 自带的 Chromium | ❌ 额外一整套 Chromium（`npx playwright install chromium`，通常 150–200 MB 级），且 Playwright 还默认装 `chromium-headless-shell` | ✅ 零额外（不装浏览器）；但要求用户机器上有目标浏览器 | ❌ 同 B |
| **版本升级与维护** | 🟡 只需跟 Electron 版本；但 Chromium 版本被 Electron 锁定（Electron 44 = Chromium 152），**新特征/新反检测能力上线晚** | 🟡 Playwright 版本与 Electron 版本各自演进 → **两套 Chromium 版本分叉**（Electron 44 = Chr 152 vs Playwright 1.63.0 = build 1243）；Patchright 还要求与 Playwright 版本对齐 | ✅ 用户浏览器自动更新，指纹最「真」；但你的驱动必须兼容未知版本，且**浏览器策略变更会直接打断你**（Chrome 136 就是先例） | 🟡 同 B |

### 2.2 Linux 特有因素（本次新增的重点）

#### (a) Electron 三者在 Linux 上的差异与坑

- **`BrowserView` 已在 Electron 29 起弃用**，官方文档明确「replaced by the new `WebContentsView` class」。新项目不要用。✅
- **`WebContentsView`**：`new WebContentsView({ webPreferences })`，`win.contentView.addChildView(view)`，`view.setBounds({x,y,width,height})`，`view.webContents.loadURL(...)`。是 `View` 的子类，参与**窗口内**的视图层级。✅
- **`webContents`**：若你已经有 `BrowserWindow`，`win.webContents` 就是当前页；也可以 `new WebContentsView({ webContents })` 收养一个已有 `WebContents`（文档明确「A WebContents may only be presented in one WebContentsView at a time」）。✅
- **Linux 上的实际差异**：这三者的 **API 语义在 Linux 与其它平台一致**；差异不在「渲染层」，而在**窗口/合成器层**（见 (b)）。所以选 `WebContentsView` 还是裸 `webContents`，在 Linux 上不是一个渲染问题，而是**UI 布局问题**：要把「自动化浏览器」嵌进我们自己的窗口（`contentView` 树），就用 `WebContentsView`。
- **真正的坑：`webContents.debugger` 与 DevTools 互斥。** 官方文档：`detach` 事件「Emitted when the debugging session is terminated. This happens either when `webContents` is closed **or DevTools is invoked** for the attached `webContents`.」→ 用户一按 F12（或你一开 DevTools），你的 CDP 连接就断。**必须监听 `detach` 并实现重连。**这在 Linux 上尤其容易踩，因为「让用户接管去排查」时用户很可能顺手开 DevTools。✅

#### (b) Wayland vs X11 —— 对「弹出可见窗口让人接管」的影响

官方 `BrowserWindow` 文档（Linux 段）原文：

> On Wayland (Linux) it is generally not possible to programmatically resize windows after creation, or to position, move, focus, or blur windows without user input. If your app needs these capabilities, run it in Xwayland by appending the flag `--ozone-platform=x11`.

配套细节：✅

- `win.focus()`：Wayland 上「the desktop environment may show a notification or flash the app icon if the window or app is not already focused」——**不一定真的抢到焦点**。
- `win.blur()`、`win.showInactive()`：**Wayland 不支持**。
- `win.setBounds()` / `setSize()` / `setPosition()`：Wayland 上同上受限。
- 最小化：Wayland 上「minimized」不是受支持的状态。

**对本项目的直接结论（🟡 推断但逻辑很硬）：**

1. **不要靠 `win.setPosition()` 把窗口挪到用户眼前。** 在 Wayland 上那是 no-op 或被合成器忽略。要「让人接管」，正确做法是让**应用主窗口本身已经在前台**（用户是主动打开这个应用的），此时只需把焦点给到窗口内的视图。
2. **视图内的定位不受 Wayland 限制。** `WebContentsView.setBounds()` 是 `View` 的窗口内布局（`view.setBounds({x,y,width,height})`），不是 OS 级窗口移动，因此 Wayland 的「不能程序化定位窗口」**不适用于它**。→ 把自动化浏览器做成 `WebContentsView`，在 Wayland 上是安全选择。✅🟡
3. **输入注入要选对层。** CDP 的 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText` 是**浏览器内部**事件（不经过 Wayland/X11 的输入栈），因此**不受合成器对合成输入的限制**；而「真的去移动 OS 鼠标」那类方案在 Wayland 上基本不可行。Electron 侧另有 `webContents.sendInputEvent(inputEvent)`（原生注入）。→ 首选 CDP `Input.*` 或 `sendInputEvent`，把 Wayland 的输入问题绕开。🟡
4. 如果你确实需要「程序化定位/抢焦点」，官方给的退路是 `--ozone-platform=x11`（走 Xwayland）。✅ ——但这会降低「新 Linux 桌面」的原生体验，建议只作为**用户可开的诊断开关**，不做默认。

#### (c) `--no-sandbox`、user namespace、容器 / 无头环境的启动约束

- **Ubuntu 24.04 起，内核在 AppArmor 配合下限制非特权 user namespace**（官方 release notes：unprivileged user namespace restrictions，「affects all programs on the system that are unprivileged and unconfined」）。Chromium/Electron 的沙箱依赖 user namespace 或 SUID helper，因此这是 Linux 上 Electron 应用最常见的启动失败来源。✅
- Electron 侧对应开关：`--no-sandbox`（文档原文：Disables the Chromium sandbox … **Should only be used for testing**）；`app.enableSandbox()` 是反向的强制开启；`sandbox: true` 仍会关闭该 renderer 的 Node.js 环境。✅
- **结论**：**不要为了跑起来就默认 `--no-sandbox`。** 这是把「渲染不可信网页」的进程从沙箱里放出来——而我们的 `WebContentsView` 恰恰在渲染外部站点。正确做法是让应用以正常方式安装（正确设置 SUID sandbox helper / 提供 AppArmor profile），把 `--no-sandbox` 限定为「容器/CI 里的测试路径」。✅🟡
- **容器 / CI**：Playwright 官方 Docker 指引要求 `--ipc=host`（否则 Chromium 可能 OOM）、`--init`（避免 PID=1 的僵尸进程），并且在需要沙箱时要**额外放开 user namespace 的 seccomp 权限**（文档给的 seccomp profile 允许 `clone` / `setns` / `unshare`）。→ 自动化跑在容器里时，这些是硬前提。✅
- **无头环境**：`--headless` 是 Chromium 的，不是 Electron 的；Electron 一般需要 X11/Wayland 或 `xvfb-run`。🟡

#### (d) Playwright / Patchright 在 Linux 需要的系统依赖

- Playwright 官方：`npx playwright install-deps`，或按浏览器装 `npx playwright install-deps chromium`，或一步到位 `npx playwright install --with-deps chromium`。✅
- **Playwright 官方支持的 Linux**：Debian 12 / 13，Ubuntu 22.04 / 24.04 / 26.04（x86-64 或 arm64）。✅ → 落在这些发行版之外的 Linux（如 Fedora、Arch）不在官方支持面内，属自担风险。
- **对 Electron 应用的现实影响**：如果选方案 B/D，你的安装包/首启检查必须能发现并安装这些 system libs（或给出明确提示）。这是**产品化成本**，不是开发期成本。
- Patchright 额外要求：Patchright 只 patch **Chromium**（README：「Patchright only patches CHROMIUM based browsers」），且是驱动层补丁（见 §4.3）。✅

#### (e) Electron 与 Playwright 的 Chromium 版本分叉

| 组件 | 版本证据 |
|---|---|
| Electron 44.4.5 | Chromium **152.0.7977.130**，Node 24.21.0（`releases.electronjs.org/releases.json`）✅ |
| Electron 43.7.5 | Chromium 150.0.7871.250 ✅ |
| Electron 42.11.8 | Chromium 148.0.7778.280 ✅ |
| Playwright 1.63.0 | 自带 `chromium` build **1243** + `chromium-headless-shell` 1243（tag `v1.63.0` 的 `packages/playwright-core/browsers.json`）✅ |

→ **两者不是同一个二进制，也不共享缓存。** 选 B/D 意味着机器上同时存在（至少）两套 Chromium，且行为可能在版本上分叉（指纹、`Sec-CH-UA`、渲染差异）。**Fab 这类「按头判定」的 Cloudflare 配置下，两套 Chromium 意味着你要处理两种指纹表现。** 这是把方案 A 放在首位的又一个理由。✅🟡

#### (f) 「用户日常浏览器」的重新假设（Linux）

原来假设 macOS 上的 Safari/Chrome。Linux 现实是：**Chrome / Chromium / Firefox 三选一（或多选）**，且 profile 目录约定与 macOS 完全不同：

| 浏览器 | 默认 profile 目录（Linux） | 备注 |
|---|---|---|
| Chrome | `~/.config/google-chrome/` | 稳定版 |
| Chromium | `~/.config/chromium/` | 发行版包 |
| Chrome（Snap） | `~/snap/chromium/common/chromium/` 一类 | 沙箱化，路径不同 |
| Firefox | `~/.mozilla/firefox/` | 非 Chromium，CDP 不适用（Firefox 走 WebDriver BiDi） |

**隔离要点（结论）：**

1. **绝不复用日常 profile。** 不指向 `~/.config/google-chrome`，也不指向 `~/.mozilla/firefox`。Playwright 官方也警告：「automating the default Chrome user profile is not supported … may result in pages not loading or the browser exiting」。✅
2. 应用自己的 profile 放在**应用私有目录**（`app.setPath('userData', …)`，见 §3），与上述任何路径都不重叠。
3. Firefox 不是本方案的选项：Patchright 只支持 Chromium，Playwright 的 `connectOverCDP` 也只支持 Chromium 系。**要把 Firefox 排除在「外接浏览器」候选之外。**✅
4. Linux 的密钥库语义与 macOS Keychain 不同：**不是「一个稳定的应用专属钥匙串项」，而是随桌面环境变化、且可能完全不存在**（KWallet / gnome-libsecret / portal.Secret，缺失时回退明文）——见 §3.4。

### 2.3 推荐

**主方案：A（Electron `WebContentsView` + 应用私有 `persist:` 分区 + 原生/CDP 驱动）。**

理由按权重排序：

1. **Fab 是 Cloudflare 前置的账号态 SPA** → 「同一份登录态」是第一约束，A 唯一做到「零摩擦共享」。
2. **必须随时交人工** → A 的浏览器就在你自己的窗口里，交接是「把焦点给视图 + 显示横幅」，不是「切换应用」。
3. **Linux/Wayland** → A 的 `WebContentsView.setBounds()` 不受 Wayland 定位限制，输入走 CDP `Input.*` 绕开合成器限制。
4. **打包体积与版本维护** → A 不引入第二套 Chromium。

**保留的退路（按触发条件）：**

- 若 Electron 内置 Chromium 的指纹被 Fab 持续拒绝（需实测）→ 降级到 **方案 B（Patchright `launchPersistentContext`）**，但仍把视图嵌回自己的窗口是做不到的，需接受「第二个窗口」；或者接受 **D**。
- **方案 C 只在一种情况下有意义**：用户明确愿意「在应用里再登录一次」，并且你能处理 Chrome 版本策略变更。作为「逃生舱」而非默认。
- **`--ozone-platform=x11`** 只作为用户可开的诊断开关，不做默认（§2.2b）。

> ⚠️ 方案 D 的可行性有一个**未验证的关键点**：`playwright.chromium.connectOverCDP()` 能否稳定驱动 Electron 自带的 `WebContentsView` 目标。Electron 就是 Chromium、官方文档也用 `--remote-debugging-port` 挂调试器，所以**高度可信**，但 Playwright 官方明确 `connectOverCDP` 是「significantly lower fidelity」且「only supported for Chromium-based browsers」，对 Electron 目标的行为未见官方背书。→ 见 §10，建议先做一个 spike。

---

## 3. Q2 登录态共享

### 3.1 `session.fromPartition('persist:xxx')` 的语义与隔离保证

官方文档原文（`session` 模块）：✅

> `session.fromPartition(partition[, options])` — Returns a `Session` instance from `partition` string. When there is an existing `Session` with the same `partition`, it will be returned; otherwise a new `Session` instance will be created with `options`.
> **If `partition` starts with `persist:`, the page will use a persistent session available to all pages in the app with the same `partition`. If there is no `persist:` prefix, the page will use an in-memory session. If the partition is empty then default session of the app will be returned.**
> To create a `Session` with `options`, you have to ensure the `Session` with the `partition` has never been used before. There is no way to change the `options` of an existing `Session` object.

**要点提炼：**

- `persist:` 前缀 = 落盘 + 全应用共享；无前缀 = **纯内存**（进程退出即丢）。→ **必须带 `persist:`**，否则「登录一次长期复用」不成立。
- **同一 partition 字符串 → 同一 `Session` 实例**（进程内单例）。→ 这就是「同一份登录态」的机制保证：UI 的任何一个 `webContents` 与自动化视图，只要用同一个分区名，cookie 就是同一份。
- `options` 只能在**首次创建**时给，之后改不了。→ 分区名要当成持久化契约来设计（**改名 = 丢登录态**）。
- 文档另有 `session.fromPath(path[, options])`：按**绝对路径**取/建 Session（非绝对路径或空串会抛错）。→ 需要「按账号隔离目录」时用它比拼 partition 名更可控。✅

**隔离保证的边界（重要）：**

- 分区隔离的是 **cookie / cache / localStorage / 存储**，`persist:` 分区之间互不可见。✅
- 但**指纹/网络层不隔离**：默认 UA、`app.userAgentFallback`、代理、`session.setProxy(config)` 是按 session 配的——`session.setUserAgent(userAgent[, acceptLanguages])` 与 `ses.setProxy(config)` 都是 **Session 实例方法**，所以「一个账号一个分区 + 一个代理」是可行的。✅
- 别把「分区隔离」误当成「隐私隔离」：同一台机器同一用户下的两个 `persist:` 目录，攻击成本差别不大。真正的密钥保护是 §3.4。

### 3.2 让「用户手动登录一次」长期复用

```
// 概念示意（不是最终实现）
const ses = session.fromPartition('persist:fab-<accountId>')   // 首次调用即固化
const view = new WebContentsView({ webPreferences: { session: ses } })
```

具体机制：✅

1. **视图绑定分区**：`WebPreferences.session` 传该 `Session`，视图内所有请求都走这份 cookie。
2. **落盘时机要注意**：cookie 文档明确「Cookies written by any method will not be written to disk immediately, but will be written every 30 seconds or 512 operations」→ 若要「用户刚登录完就保证写盘」，显式调 `ses.cookies.flushStore()`。✅ **这是「登录一次长期复用」里最容易漏的一步**（用户登录后立刻关应用 → 丢登录态）。
3. **登录态探针**：Fab 上直接用 `/i/users/me`（✅ 已实测该路径存在）。应用侧可在主进程用 `ses.fetch` 或 `net.fetch` 探测，也可以让页内脚本探测后经 `ipcRenderer`/`webContents.ipc` 回报。
4. **失效处理**：不要把「登录态」当成永久资产。给出「需要重新登录」的显式状态（见 §6），而不是静默失败。
5. **账号切换**：每个账号一个分区（`persist:fab-<accountId>`）→ 天然多账号并存，互不污染。**但注意 partition 名一旦定下就是数据契约**（§3.1）。

### 3.3 确保不与用户日常浏览器互相影响

- 应用 profile 根目录：**用 `app.setPath('userData', <app-private-dir>)`**（`app` 模块方法）显式钉死，别依赖默认值。默认路径是 `<userData>`（Linux 上 `~/.config/<AppName>` 一类），虽然与 `~/.config/google-chrome` 不冲突，但显式设置更安全。✅
- **绝对不做的事**：
  - 不要让 Playwright `launchPersistentContext()` 指向 `~/.config/google-chrome` / `~/.config/chromium` / `~/.mozilla/firefox`。Playwright 文档明确警告会「pages not loading or the browser exiting」。✅
  - 不要把应用 profile 放进 `~/.config/google-chrome/Default` 之类的路径下方。
- **Chrome 136 的政策变更**（§2.1）其实是**保护**你：它让「偷用日常 profile 的调试端口」变难。别去绕过它。✅
- **Snap/Flatpak 的 Chrome/Chromium** 位于 `~/snap/...`，沙箱化，与系统路径不同——即便你想「外接」，路径假设也会碎。🟡

### 3.4 cookies 的落盘位置与加密情况

**(1) 落盘位置 —— 从 Electron 源码读出来的，不是猜的**

`shell/browser/electron_browser_context.cc`：✅

```cpp
// Convert string to lower case and escape it.
std::string MakePartitionName(const std::string& input) {
  return base::EscapePath(base::ToLowerASCII(input));
}
...
if (!in_memory && !partition_loc.empty()) {
  path_ = path_.Append(FILE_PATH_LITERAL("Partitions"))
                  .Append(base::FilePath::FromUTF8Unsafe(MakePartitionName(partition_loc)));
}
```

→ **`persist:` 分区的数据目录 = `<userData>/Partitions/<partition 名转小写 + 路径转义>/`。** 分区名先 `ToLowerASCII` 再 `EscapePath`（例如 `persist:fab-Acc1` → `fab-acc1`）。**这意味着分区名大小写不敏感且会被转义——不要依赖分区名里的特殊字符。**✅

- 有官方 API 直接查这个路径：**`ses.getStoragePath()`** — 「Returns `string | null` - The absolute file system path where data for this session is persisted on disk. **For in memory sessions this returns `null`.**」✅ → 这是「诊断登录态存哪儿」的正规入口，也是「内存分区」的可观测判据。
- cookie 数据库文件本身是 Chromium 的 SQLite `Cookies`（在该 partition 目录下的网络服务存储位置）。**具体子路径（`Network/Cookies` 与否）本文未逐字核实 → ❓ §10。** 结论性建议：**别硬编码 cookie 文件路径，用 `ses.cookies.get()` / `ses.cookies.set()` / `flushStore()` 这套 API。**
- **写盘延迟**：30 秒或 512 次操作（官方原文）。✅

**(2) 加密情况 —— 分三层，别混为一谈**

| 层 | 机制 | 结论 | 级别 |
|---|---|---|---|
| **cookie / 站点凭据** | Chromium 的 `os_crypt`（与 `--password-store` 选择相关） | Linux 上由桌面环境选 KWallet / gnome-libsecret；**无可用 secret store 时回退到 plain text store** | ✅（Chromium 官方 `docs/linux/password_storage.md`） |
| **应用自己的密钥** | Electron `safeStorage` | Linux async 优先 `org.freedesktop.portal.Secret`，其次 Secret Service / KWallet；**没有 secret store 时就等于未保护**，可用 `safeStorage.getSelectedStorageBackend() === 'basic_text'` 检测 | ✅（Electron `safe-storage.md`） |
| **Windows 的 App-Bound Encryption** | Chrome 专有 | **Electron 没有**（在 `electron/electron` 中检索 `app_bound_encryption` / `AppBoundEncryption` 无命中） | 🟡（检索无命中 ≠ 绝对不存在） |

**关键实操结论：**

- Chromium 官方原文（`--password-store`）：`--password-store=basic`（to use the plain text store），「Chromium will fall back to `basic` if a requested or autodetected store is not available.」✅ → **在无 keyring 的 Linux（很多 headless/容器/精简桌面）上，cookie 实际上是「只做了混淆、没有真加密」。**
- Electron 有 `safeStorage.setUsePlainTextEncryption(usePlainText)`（Linux 专用，强制内存口令）。**不要主动打开它。**✅
- Electron 46 移除了 `safeStorage` 的**同步 API**（`isEncryptionAvailable`/`encryptString`/`decryptString`），改用 `isAsyncEncryptionAvailable`/`encryptStringAsync`/`decryptStringAsync`。→ 如果本项目要存敏感凭据，**现在就按 async API 设计**，别绑同步版。✅
- **cookie 加密与 `safeStorage` 是否共用同一把 key：❓ 未验证**（两者都走 OS secret store，但属不同代码路径）。→ 不要基于「它们共用 key」做设计假设。见 §10。

---

## 4. Q3 反自动化现状

### 4.1 Cloudflare —— 在 Fab 上做了实测

**已测到的（✅）：**

- Fab / Epic Store 都是 Cloudflare 前置，裸 HTTP 客户端拿到 `403` + `cf-mitigated: challenge`，挑战类型 `cType: 'managed'`。
- 只要补上 `sec-ch-ua` 或 `sec-fetch-*` 就 **200**。
- 响应带 `accept-ch` / `critical-ch: Sec-CH-UA-Bitness, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version, …, UA-Platform` —— 这是 Cloudflare 在**主动要求 UA 客户端提示**。

**结论：**

1. Cloudflare 对 Fab 的门槛**不是「无头检测」，而是「你是不是一个会说现代浏览器话的客户端」**。真实 Chromium（Electron/Playwright）默认就满足。✅
2. **这同时是一个陷阱**：如果你为「反检测」而手改 UA 串，就可能制造 **UA 串 ↔ Sec-CH-UA 不一致**，反而触发挑战。见 §4.3。
3. **不要试图「自动过 Cloudflare 挑战」**。managed challenge 一旦真的被触发（而非被头挡住），正确做法是**交人工**（§6）。理由：过盾的收益是「少点几下」，代价是账号与合规风险，且方案随 Cloudflare 更新随时失效。

### 4.2 hCaptcha / reCAPTCHA

- **hCaptcha：Fab 实测加载 `js.hcaptcha.com/1/api.js?render=explicit&uj=true`**（✅）。`render=explicit` 表示由页面脚本决定何时渲染 → 通常是**登录或敏感动作**时弹出。这就是必须实现「交人工」流程的直接证据。
- **reCAPTCHA：本次未在 Fab 上观察到。** 不排除其它资产商店使用。❓
- **两者的反自动化态度（一手来源不足）**：Google/hCaptcha 的官方文档不会给出「是否拦 Playwright」的清单式答案。→ **不要引用社区博客当结论。** 本项目应采用的立场是：**只要人机校验出现，一律交人工**，不去研究「怎么骗过它」。这同时是技术与合规上的最省力解。✅
- 可用的**检测信号**（推断，非官方清单，🟡）：页内脚本探测 hCaptcha 常见宿主元素（如 `iframe[src*="hcaptcha.com"]`、`[data-hcaptcha-widget-id]`）/ reCAPTCHA（`iframe[src*="recaptcha"]`、`.g-recaptcha`），以及 CDP 侧观察 `Page.frameNavigated` / `DOM.getDocument` 里出现对应 frame。→ **这些选择器要写成本项目的适配器，而不是 hardcode 在核心流程里。**

### 4.3 反检测分支（Patchright 等）的现状、活跃度与风险

**Patchright（`Kaliiiiiiiiii-Vinyzu/patchright`）实测数据**（`gh api repos/...`，2026-09-26）：✅

| 项 | 值 |
|---|---|
| Star | 4,680 |
| 许可 | Apache-2.0 |
| 最后 push | 2026-09-13 |
| 归档 | 否 |
| 描述 | "Undetected version of the Playwright testing and automation library." |

**它到底改了什么**（README，重要，别被营销词带跑）✅：

- **最大的补丁是规避 `Runtime.enable` 泄漏**：Patchright 通过「在（隔离的）Execution Context 中执行 JS」来避免使用 `Runtime.enable`。
- **`Console.enable` 泄漏**：直接禁掉 Console API → **Patchright 下 console 不工作**。
- **命令行 flag 泄漏**：加 `--disable-blink-features=AutomationControlled`（规避 `navigator.webdriver`），去掉 `--enable-automation`、`--disable-popup-blocking`、`--disable-component-update`、`--disable-extensions`。
- **其它**：可操作 Closed Shadow Root；通用泄漏修补。
- **只 patch Chromium**；Firefox / WebKit 不支持。
- **自述通过** Brotector / Cloudflare / Kasada / Akamai / Shape-F5 / Datadome / Fingerprint.com / CreepJS / Sannysoft / Incolumitas / IPHey / Browserscan / Pixelscan —— **这是厂商自述，不是第三方审计**。🟡
- README 自认「passes most, but not all the Playwright tests」，部分 bug「considered impossible to solve」。✅

**风险（明确的、可操作的）：**

1. **维护单点**：主要维护者 1 人（`Vinyzu`），「Active Maintainer」+「Co-Maintainer」。4680 star 但**发布节奏依赖上游 Playwright 改动**，README 自己写：「bugs due to Playwright codebase changes may occur. Fixes … might take a few days」。→ 你的 CI 可能被上游 Playwright 的一次 release 打挂。✅
2. **与 Playwright 版本强耦合**：Patchright 是**驱动层补丁**，必须跟 Playwright 版本对齐。你在 Electron 里再叠一层版本约束，维护面继续放大。✅🟡
3. **功能性代价**：**console 不可用**（README 明说）。调试期会很痛。✅
4. **CDP 连接场景下有效性存疑**：Patchright 的关键补丁（避免 `Runtime.enable`、改 launch flags）**建立在「由它自己启动浏览器」的前提上**。若走 `connectOverCDP` 连一个已存在的浏览器，flag 已经定死了。→ **Patchright + 方案 D 的组合有效性 ❓ 未验证**。README 另有指向 `CDP-Patches` 仓库用于 Brotector，说明这条路存在但不是主路径。
5. **合规/态度风险**：README 自带 disclaimer「educational purposes only … Use at your own risk」。把它作为默认方案会把项目绑定到一个明确「反检测」的定位上——对「游戏资产管家」这类**用户自己账号、用户自己资产**的产品，这不是必要的品牌风险。

**同类参照（活跃度对比，2026-09-26）**：✅

| 仓库 | Star | 许可 | 最后 push | 备注 |
|---|---|---|---|---|
| `microsoft/playwright` | 96,682 | Apache-2.0 | 2026-09-26 | 事实标准 |
| `browser-use/browser-use` | 116,312 | MIT | 2026-09-25 | Python |
| `microsoft/playwright-mcp` | 37,572 | Apache-2.0 | 2026-09-25 | Node 包 |
| `browserbase/stagehand` | 25,394 | MIT | 2026-09-25 | TS SDK |
| `Skyvern-AI/skyvern` | 23,068 | **AGPL-3.0** | 2026-09-26 | 注意 AGPL |
| `ultrafunkamsterdam/undetected-chromedriver` | 12,854 | **GPL-3.0** | **2025-07-05** | Selenium 系，**近一年未更新** |
| `Kaliiiiiiiiii-Vinyzu/patchright` | 4,680 | Apache-2.0 | 2026-09-13 | 见上 |
| `lightpanda-io/browser` | 35,577 | **AGPL-3.0** | 2026-09-26 | 非 Chromium |
| `webllm/browser-use`（npm `browser-use`） | **14** | MIT | 2026-07-16 | ⚠️ 与 Python 项目同名但无关 |

> ⚠️ **许可陷阱**：`undetected-chromedriver` 是 **GPL-3.0**、`skyvern` 是 **AGPL-3.0**。**不要**把 AGPL/GPL 代码静态链进闭源 Electron 应用。Patchright / Playwright / Playwright MCP / Stagehand / browser-use 都是 Apache-2.0 或 MIT，这一层相对安全。✅

**推荐立场**：**默认不用 Patchright。** 只在「Electron 内置 Chromium 实测被 Fab 拒绝」时才作为可选驱动后端引入，并把 Patchright 的版本与 Playwright 版本一起锁死。

---

## 5. Q4 「模型 + 浏览器」的通用化路径

### 5.1 页面表示：DOM 快照 / a11y 树 / 截图，谁是主流？

**答案是：a11y 树为主、截图兜底（混合），这是当前主流，不是小众。**证据：

| 表示 | 一手证据 | 级别 |
|---|---|---|
| **a11y 树（主）** | Playwright MCP 官方 README：「Uses Playwright's accessibility tree, **not pixel-based input**」、「**Fast and lightweight**」；并把「bypassing the need for screenshots or visually-tuned models」写成产品定位 | ✅ |
| **a11y 树 + 元素引用（AI 优化）** | Playwright `locator.ariaSnapshot({ mode: 'ai' })`：`mode: "ai"` → 「returns a snapshot optimized for AI consumption」，**包含元素引用 `[ref=e2]`**，并支持 `boxes: true` 附上每个元素的 bounding box（viewport 相对、CSS 像素） | ✅ |
| **a11y 树（测试断言）** | `expect(locator).toMatchAriaSnapshot(expected)`（v1.49+），YAML 形式，可用作**确定性等待/断言** | ✅ |
| **CDP 原生等价物** | `Accessibility.getFullAXTree`（「Fetches the entire accessibility tree for the root Document」）、`Accessibility.enable`（使 `AXNodeId` 在多次调用间保持一致）、`Accessibility.queryAXTree`、`Accessibility.getPartialAXTree` | ✅ |
| **DOM 全量快照** | `DOMSnapshot.getSnapshot` / `DOMSnapshot.captureSnapshot`（「including the full DOM tree of the root node (including iframes, template contents, and imported contents)」）——信息最全，但**体积最大、给模型的信噪比最差** | ✅ |
| **DOM 精确查询** | `DOM.getDocument`、`DOM.querySelector`、`DOM.getBoxModel`、`DOM.getContentQuads`、`DOM.describeNode`、`DOM.performSearch` | ✅ |
| **截图** | `Page.captureScreenshot`、`Page.startScreencast` + `Page.screencastFrameAck`（做实时预览/录像）；Electron 侧 `webContents.capturePage([rect, opts])` | ✅ |
| **输入** | `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`；Electron 侧 `webContents.sendInputEvent(inputEvent)` | ✅ |

**结论与建议的表示策略（本项目的具体答案）：**

1. **主输入：a11y 树（带 ref + 可选 bbox）。** 理由：体积小、语义好、天然可定位（ref 可映射回节点），且 Playwright MCP 已证明这条路在真实 agent 里可用。✅
2. **不要用整页 DOM 快照喂模型**：`DOMSnapshot.captureSnapshot` 的产出在 Fab 这种 2.3 MB 首屏的 SPA 上会直接爆上下文。**只在「a11y 树不足以判断」时，用 `DOM.querySelector` / `executeJavaScript` 做**定向**提取。**✅🟡
3. **截图作为兜底与人类可读证据**：当 a11y 树无歧义地失败（例如纯 canvas 控件、谜题式验证码），或需要**给人看**时，用 `Page.captureScreenshot` / `capturePage()`。**不要把它当主输入**（像素级输入慢且吃模型预算 —— Playwright MCP README 的定位正是这个意思）。✅
4. **模型决策的输出应是「意图」，不是「直接执行」。** 让 Pi agent 产出结构化的动作（`{action:'click', ref:'e12'}` / `{action:'type', ref:'e3', text:...}` / `{action:'needs_human', reason:'captcha'}`），由应用侧在 `WebContentsView` 上执行。**这是「人工兜底」能做成的前提**：只有应用侧持有执行权，才能在 `needs_human` 时把控制权交出去。🟡

### 5.2 是否值得复用成熟项目而不是自研？

**值得。逐个裁决：**

#### (1) `browser-use/browser-use`

| 项 | 值 | 级别 |
|---|---|---|
| Star / 许可 / 最后 push | 116,312 / **MIT** / 2026-09-25 | ✅ |
| 语言 | **Python**（仓库内 7,648 个 `.py`，根目录 `pyproject.toml`） | ✅ |
| CDP 支持 | 有。`BrowserSession(browser_profile=BrowserProfile(cdp_url='http://localhost:9222', is_local=True))`（官方 `examples/browser/using_cdp.py`） | ✅ |
| 登录态 | `StorageStateWatchdog`：cookies/localStorage 持久化，`auto_save_interval=30.0`、`save_on_change=True` | ✅ |
| 暂停交人工 | `Agent.pause()`（`browser_use/agent/service.py`）存在；有 `CaptchaWatchdog` | ✅ |
| **CaptchaWatchdog 的真实能力** | 它监听的是 **`BrowserUse.captchaSolverStarted` / `captchaSolverFinished` CDP 事件**，注释明说「Monitors captcha solver events from **the browser proxy**」——**这是他们云端的 captcha solver**，不是通用的人工兜底 | ✅ |

**裁决：❌ 不推荐嵌入。** 三个原因：
1. **Python** → 嵌 Electron 必须带一个 Python sidecar（打包、跨发行版兼容、生命周期管理全要自己扛）。这直接违反「最省力」原则。
2. **它的人机兜底是「云端自动解验证码」**，与本项目「交人工」的合规立场相反。要用它的 `pause()` 反而要绕过它的 captcha 路径。
3. ⚠️ **npm 上那个 `browser-use@0.8.0`（`webllm/browser-use`）不是它**：只有 **14 star**，最后 push 2026-07-16，自称「browser-use for TypeScript」。**别把两者混淆。**

#### (2) `browserbase/stagehand`

| 项 | 值 | 级别 |
|---|---|---|
| Star / 许可 / 最后 push | 25,394 / **MIT** / 2026-09-25 | ✅ |
| 语言 / 包 | **TypeScript**（`@browserbasehq/stagehand`），另有 Python / Go SDK | ✅ |
| **能否嵌入 Electron** | ✅ 高可信。它跑在 Node 里，`localBrowser.launch({ userDataDir })` 直接 **spawn 一个 Chrome 并等 `http://127.0.0.1:<port>` 就绪**（`launchLocalBrowser()` → `launchChrome()` → `waitForChrome(cdpUrl)`），返回 `{ cdpUrl, close }` | ✅ |
| **能连已有浏览器吗** | ✅ 可以。`StagehandBrowserOrigin = "launched" \| "connected"`，且 `LocalBrowserConnectOptionsSchema = { cdpUrl: string, extensionId?: string }` → **`cdpUrl` 是官方一等参数** | ✅ |
| 登录态 | README 首例就是 `localBrowser.launch({ userDataDir: "./browser-data" })`：「Cookies persist in ./browser-data, so the next run starts already signed in」 | ✅ |
| 页面表示 | `observe()` 返回**真实 selector**（README 强调「credentials never reach the model」）、`act()`「self-heals when the site redesigns its form」、`extract()` 返回 **schema 校验过**的数据 | ✅ |
| 暂停交人工 | ❓ 未见一等公民的「pause/handoff」API（需实测） | ❓ |

**裁决：✅ 推荐作为「模型+浏览器」层。** 理由：TypeScript 原生（同进程/同语言）、MIT、`cdpUrl` 一等支持（**这让方案 A 与 D 都能接它**）、`observe() 返回 selector 而不把凭据送进模型**这一点对本项目的隐私红线（#10）直接有利。**唯一的未知是人机兜底是否一等支持**（§10）。

#### (3) `microsoft/playwright-mcp`

| 项 | 值 | 级别 |
|---|---|---|
| Star / 许可 / 最后 push | 37,572 / **Apache-2.0** / 2026-09-25 | ✅ |
| 形态 | **Node 包**（`npx @playwright/mcp@latest`），MCP server over stdio → **可被 Electron 主进程 spawn** | ✅ |
| 连接方式 | `--cdp-endpoint <endpoint>`、`--extension`（连已运行浏览器，Edge/Chrome，需装 Playwright Extension）、`--user-data-dir`、`--profile-dir-name`、`--shared-browser-context`、**默认 headed**（`--headless` 才无头）、`--idle-timeout` | ✅ |
| 页面表示 | a11y 快照（见 §5.1）；`--snapshot-mode full\|none`、`--snapshot-boxes` | ✅ |
| 登录态 | `--extension` 模式官方描述：「connect to existing browser tabs and **leverage your logged-in sessions and browser state**」 | ✅ |
| 暂停交人工 | ❓ 无一等公民 API。⚠️ 但注意 README 的一条重要提醒：CLI + SKILLs 可能比 MCP 更省 token（「avoid loading large tool schemas and verbose accessibility trees into the model context」） | ✅ |

**裁决：✅ 推荐（作为「最省力的 agent 层」），但有一个架构警告。** 它是**外挂进程 + 通过端口连浏览器**，因此天然属于方案 D 的形状（`--cdp-endpoint` 连到 Electron 的 `--remote-debugging-port`）。它能给你「立刻可用的模型驱动页面决策」，但**「把窗口交给用户」这一步它不管** → 仍由应用侧（§6）负责。若选它，务必先验证 §10 里的 `connectOverCDP`→Electron 那条。

#### (4) 通用 MCP 能力：`elicitation`（用于「交人工」的协议设计）

MCP 规范（版本 `2025-06-18`）新增 **Elicitation**：服务端可以在交互过程中**向用户请求结构化输入**，由客户端负责呈现，用 JSON Schema 校验响应。规范给出三种 Response Action，且明确「Implementations are free to expose elicitation through any interface pattern that suits their needs—the protocol itself does not mandate any specific user interaction modality」。✅

**裁决：✅ 值得作为「人工兜底协议」的参考模型**（即使你不用 MCP）。它的 shape 正好是我们要的：**代理侧发一个「我需要人来处理 X」的请求 → 客户端（我们的 Electron UI）负责呈现 → 用户操作后返回一个结构化结果**。规范本身也说明该设计「may evolve」。

#### (5) 其它：`Skyvern`（AGPL-3.0, 23k★）、`lightpanda`（AGPL-3.0, 非 Chromium）

**裁决：❌**。AGPL 许可不适合闭源 Electron 应用；lightpanda 不是 Chromium（拿不到用户的真实 Chromium 指纹）。

---

## 6. Q5 人工兜底机制（API 级做法）

### 6.1 状态机（先定协议，再定 API）

```
idle → running ──(触发)──> needs_human(reason, view_id) ──(用户确认/自动探测)──> resumed → running
                    │                                                              │
                    └──(成功)──> done                                              └──(再次触发)──> needs_human
```

`reason` 至少枚举：`captcha` / `two_factor` / `login_required` / `unknown_page` / `sensitive_confirm` / `cloudflare_challenge` / `manual_abort`。

**设计原则（最省力）：** 「交人工」= **暂停代理循环 + 把焦点交给用户 + 等一个完成信号**。不要做「代理继续在后台猜」。

### 6.2 把真实窗口交给用户（具体 API）

```
// 1) 确保窗口在前台（Wayland 下不要指望 setPosition，见 §2.2b）
win.show()                       // 显示并给焦点
win.focus()                      // Wayland 上可能只是「闪一下任务栏」，见下
// 2) 焦点给到自动化视图本身（用户可以直接点击/输入）
view.webContents.focus()         // ✅ 存在（docs/api/web-contents.md `contents.focus()`）
// 3) 需要时放大/切换布局：把视图铺满 contentView（窗口内布局，Wayland 安全）
view.setBounds({ x: 0, y: 0, width: w, height: h })   // ✅ View.setBounds
```

**Wayland 的现实提醒**：`win.focus()` 在该平台上「the desktop environment may show a notification or flash the app icon if the window or app is not already focused」→ **把「让用户看见」设计成「用户自己打开的应用内切换到一个明显的接管态」**（例如整窗覆盖 + 醒目横幅 + 声音/系统通知），而不是依赖程序抢焦点。`win.showInactive()` 与 `win.blur()` 在 Wayland 上不可用。✅

### 6.3 在页面上打出「交给你了」的信号（可选但推荐）

```
// 视觉：让用户明确知道现在是他在操作
view.webContents.insertCSS(CSS_BANNER)                  // ✅ contents.insertCSS(css[, options])
// 交互：往页面注入一个小工具条 + 一个「我完成了」按钮
view.webContents.executeJavaScript(BANNER_SCRIPT)       // ✅ contents.executeJavaScript(code[, userGesture])
```

`executeJavaScriptInIsolatedWorld(worldId, scripts[, userGesture])` 也存在（✅），**推荐用它注入工具条**，避免污染站点自己的 JS 环境、也避免被执行站点脚本读到。

### 6.4 感知「用户完成」——三级信号（从强到弱，组合使用）

| 级别 | 机制 | 具体 API | 适用 |
|---|---|---|---|
| **1. 显式桥（最强）** | 用户在注入的工具条上点「我完成了」→ 页内脚本经 IPC 回报主进程 | 注入脚本 `ipcRenderer.send(...)`；主进程 `webContents.on('ipc-message', (event, channel, ...args) => …)` ✅ | 任何未知页面；用户明确知道自己做完了 |
| **2. 站点探针（推荐与 1 并用）** | 轮询一个**业务级完成谓词** | Fab：`/i/users/me` 返回 200（已登录）；或 a11y 树里出现目标节点（`Accessibility.getFullAXTree` + 谓词）；或 `DOM.querySelector` 命中 | 有明确终态的页面（登录完成、claim 完成） |
| **3. 导航稳定（兜底）** | 「页面对话结束了」的启发式 | `webContents` 事件：`did-navigate`、`did-navigate-in-page`、`dom-ready`、`did-stop-loading`、`did-fail-load`、`page-title-updated`；CDP `Page.setLifecycleEventsEnabled` + lifecycle 事件、`Page.getFrameTree` ✅ | 只是「可能完成了」，**必须再叠加一次 a11y/探针确认**，否则会误判 |

**为什么必须三级并用**：Fab 是 SPA，`did-navigate` **不一定触发**（in-page 路由）；验证码解决后页面可能只是 DOM 变化。**只靠导航事件会挂死**，只靠显式桥则用户可能忘记点按钮。🟡

**同时要监听 `webContents.debugger` 的 `detach`**：用户开 DevTools 会踢掉你的 CDP 会话（官方文档明确），必须在 `resumed` 时重新 `attach('1.1')` 并重新快照。✅

### 6.5 恢复代理上下文（最容易做错的一步）

**原则：不要「接着用旧的上下文」，而是「暂停 → 重快照 → 重建上下文」。**

1. `needs_human` 时**冻结**代理循环（不产生新动作），保存 `reason` + 当前 URL + 一份 a11y 快照（供事后解释/审计）。
2. 用户操作期间，**应用侧可以继续采集事件**（导航、a11y 快照 diff），但**不做任何注入输入**。
3. `resumed` 时：
   - `debugger.isAttached()` 为假则重新 `attach`；
   - 重新取 `Accessibility.getFullAXTree` + 当前 URL + `/i/users/me` 一类探针；
   - **用新快照重建代理上下文**，把 `reason` 的解决结果作为一条系统消息交给 Pi agent（例如「用户在 2FA 页完成了验证，已回到 /library」）；
   - 只保留「任务级」记忆（目标、已完成步骤），**丢弃「页面级」记忆**（旧的 ref/坐标在 DOM 变化后必然失效）。
4. **不要重放之前失败的动作**。重放是「交人工」最常见的 bug 来源。

### 6.6 两个必须处理的边界

- **弹出窗口 / OAuth / 2FA 弹窗**：`webContents.setWindowOpenHandler(handler)`（✅）必须实现——否则登录跳转会在一个你无法控制的窗口里发生（或直接静默失败）。`new-window` 类行为要显式决定「在当前视图打开」还是「交给人工」。
- **敏感动作二次确认**：claim / 购买 / 账号设置一类，走同一个 `needs_human` 通道而不是自动化，`reason: 'sensitive_confirm'`。这与 issue #9 的权限模型一致。

---

## 7. Q6 可测试性

### 7.1 三个测试层（别混在一起）

| 层 | 测什么 | 手段 |
|---|---|---|
| **L1 页面理解 / 决策** | 「给定页面快照，agent 是否选对动作」 | **fixture 页面**（本地 HTML）+ 录制的页面表示（a11y 快照 / 截图）→ 纯函数式测试，不需要网络 |
| **L2 适配器 / 流程** | 「Fab 登录态探针、claim 流程、交人工触发」 | **HAR 录制-回放** + `session.webRequest` 拦截 + fixture 页面 |
| **L3 应用端到端** | 「真实 Electron 应用能开、能嵌视图、能交接」 | **Playwright 的 Electron 支持**：`_electron.launch({ args: ['main.js'] })` + `electronApp.firstWindow()` |

### 7.2 具体机制（都用官方 API）

**(1) 网络录制-回放 —— 首选**

- Playwright：`page.routeFromHAR('./hars/fab.har', { url: '*/**/i/*', update: false })`。官方说明：「Replay API requests from HAR. Either use a matching response from the HAR, or abort the request if nothing matches.」以及 **「HAR replay matches URL and HTTP method strictly. For POST requests, it also matches POST payloads」**。✅
- 录制：`page.routeFromHAR(..., { update: true })` 或建 context 时 `recordHar`。✅
- **HAR 是「流程测试」的正解**：Fab 的 `/i/*` 都是 JSON，回放稳定且确定性强。

**(2) 精细 mock —— 用于边界**

- `page.route('*/**/api/v1/fruits', route => route.fulfill({ json }))`；也要支持「先真请求再改响应」的 `route.fetch()` + `route.fulfill({ response, json })`。✅
- Electron 侧等价物：`session.webRequest`（可拦截/改请求）+ 自定义 `protocol` handler。🟡

**(3) fixture 页面 —— 让「未知页面」变成可测输入**

自己写 `fixtures/*.html` 模拟：登录表单、2FA 输入页、hCaptcha 占位（伪造 `iframe[src*=hcaptcha]`）、SPA 路由（不触发 `did-navigate`）、以及「点击后 DOM 变化但不导航」的页面。**这是本项目的测试主力**——因为真正的价值在于「遇到没见过的东西会停下来」，而这件事只能在 fixture 上测。

**(4) 确定性等待条件 —— 这是「不 flaky」的全部秘密**

- **Playwright 的 web-first 断言**：`await expect(locator).toBeVisible()` 这类断言自身**自动重试**（官方 Best Practices 的核心建议）。✅
- **a11y 断言**：`await expect(page.locator('body')).toMatchAriaSnapshot(\`- heading "Fab"\`)`（v1.49+）→ **把「页面结构符合预期」变成可断言的字符串**。✅
- **Electron 侧**：用 `webContents` 的显式事件（`dom-ready` / `did-stop-loading`）而不是 `setTimeout`；CDP 侧用 `Page.setLifecycleEventsEnabled` 后的 lifecycle 事件，或 `Accessibility.getFullAXTree` 的谓词轮询。
- **明确禁止**：`sleep(n)` 作为等待手段。在 Fab 这种 SPA + Cloudflare 的页面上，固定 sleep 必然在两个方向上都错。

**(5) 登录态的可测性**

- 保存/恢复 `storageState`（Playwright）或直接用 `persist:` 分区目录。**测试里用一次性临时目录**（`launchPersistentContext('')` 会建临时目录，或 `mkdtemp`），**绝不复用开发机上的真实登录态**。✅
- Playwright 官方警告：「The browser state file may contain sensitive cookies and headers that could be used to impersonate you … We strongly discourage checking them into private or public repositories.」→ 把 auth 目录加进 `.gitignore`。✅

**(6) 应用级 E2E**

- `_electron.launch({ args: ['main.js'] })` + `electronApp.evaluate(({ app }) => app.getAppPath())` + `electronApp.firstWindow()`。✅
- 已知坑（官方列）：若启动超时，检查 `nodeCliInspect`（`FuseV1Options.EnableNodeCliInspectArguments`）fuse 是否被设为 `false`。✅
- **原生对话框无法被 Playwright 拦截**（`dialog.showOpenDialog` 等在主进程直接走 OS）→ 用 `electronApp.evaluate()` 在测试里替换成 stub。✅
- 支持版本：Electron v12.2.0+ / v13.4.0+ / v14+。✅

### 7.3 针对本项目的测试策略建议

1. **把「交人工」做成可注入的边界。** 定义 `HumanGate` 接口（`request(reason) → Promise<resolution>`），测试里注入一个「立刻返回 `resolved`」或「返回 `aborted`」的假实现。→ **整条流程可在无人环境下测完**，包括「用户在 2FA 页完成了」这条路径。
2. **每个站点的适配器都要有 golden a11y 快照。** 用 `toMatchAriaSnapshot` 固定「登录页 / 已登录页 / claim 确认页 / 验证码页」四种形态；站点改版时**测试先红，而不是生产先挂**。
3. **把 Cloudflare/hCaptcha 当成一等测试输入**：fixture 里放一个返回 `403 + cf-mitigated: challenge` 的 mock（HAR 或 `route.fulfill`），断言「应用进入 `needs_human(reason='cloudflare_challenge')` 而不是重试」。
4. **L1 用录制的真实快照做回归**：把真实的 Fab a11y 快照存成文本 fixture，测「模型决策函数」的输入输出。→ 不需要网络、不需要模型额度、毫秒级。
5. **网络层不做「真连 Fab」的自动化测试**（不稳定、不礼貌、且会触发挑战）。保留一个**手动触发**的 smoke test。
6. **时间相关的都做成可注入的 Clock**（登录态过期、退避、超时）。

---

## 8. 推荐方案

### 8.1 进程 / 窗口模型

```
Electron 主进程
├── 应用主窗口 (BaseWindow / BrowserWindow)
│   ├── WebContentsView #1  → 我们的 React UI        (session: persist:ui-<accountId>)
│   └── WebContentsView #2  → 自动化浏览器（Fab）      (session: persist:store-fab-<accountId>)
├── 内嵌 Pi agent（独立进程，见 issue #4）
└── 可选：Stagehand / Playwright MCP 作为「页面理解 + 动作规划」层
```

- **视图**：`WebContentsView`（不用已弃用的 `BrowserView`）。`win.contentView.addChildView(view)` + `view.setBounds(...)`。✅
- **驱动**：**默认 Electron 原生 + CDP**：
  - 读取结构：`Accessibility.getFullAXTree`（`webContents.debugger.sendCommand`）/ `DOM.querySelector` / `webContents.executeJavaScript`（定向提取）
  - 输入：CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`（绕开 Wayland 输入限制），备选 `webContents.sendInputEvent`
  - 像素：`webContents.capturePage()` 或 `Page.captureScreenshot`
  - **必须处理 `debugger` 的 `detach`**（用户开 DevTools 会踢掉）✅
- **可选增强（不改架构）**：用 Stagehand 的 `LocalBrowserConnectOptions = { cdpUrl }` 或 Playwright MCP 的 `--cdp-endpoint` 接到自己的 `--remote-debugging-port` 上（= 方案 D）。**但先做 spike 验证 `connectOverCDP` → Electron 目标。**（§10）

### 8.2 登录态策略

1. **一个账号一个 `persist:` 分区**：`session.fromPartition('persist:store-fab-<accountId>')`；分区名视作**数据契约**，定下不改（改了 = 丢登录态）。✅
2. **`userData` 显式钉死**：`app.setPath('userData', <app-private-dir>)`；数据实际落在 `<userData>/Partitions/<escape(lower(partition))>/`（源码级事实）。✅
3. **用户登录一次**：视图加载 Fab → 用户手动登录（含 2FA/hCaptcha）→ 完成信号（`/i/users/me` 200）→ **立刻 `ses.cookies.flushStore()`**（否则可能等 30s 或 512 次操作才落盘）→ 之后长期复用。✅
4. **绝不触碰日常浏览器 profile**（`~/.config/google-chrome`、`~/.config/chromium`、`~/snap/...`、`~/.mozilla/firefox`）。✅
5. **应用自己的秘密**（API key 等）走 `safeStorage` 的 **async API**（同步 API 在 Electron 46 已移除），并在 Linux 上用 `getSelectedStorageBackend() === 'basic_text'` 检测「实际未加密」并**如实告知用户**。✅
6. **不假设 cookie 加密可靠**：无 keyring 的 Linux 上 cookie 只是混淆。→ 不要靠磁盘加密当作安全边界。✅

### 8.3 模型驱动页面理解的具体表示

**a11y 树为主（带 ref + 可选 bbox）+ 定向 DOM 查询 + 截图兜底。**

- 首选 CDP `Accessibility.getFullAXTree`（先 `Accessibility.enable()` 使 `AXNodeId` 稳定）✅
- 若走 Playwright 路线：`locator.ariaSnapshot({ mode: 'ai' })`（`[ref=eN]`，可选 `boxes: true`）✅
- 给模型的输入：**裁剪过的 a11y 树**（限深度/体积）+ 当前 URL + 上一步动作结果
- 给模型的输出：**结构化意图**（`click ref` / `type ref text` / `needs_human reason` / `extract schema`），由应用侧执行
- **明确不用**：整页 `DOMSnapshot.captureSnapshot` 喂模型（体积爆炸）；像素级输入当主路径
- 隐私：**凭据不进模型**（学 Stagehand `observe()` 的做法：模型只给 selector，值由应用侧填）

### 8.4 人工兜底协议

**显式状态机 + 三级完成信号 + 重快照恢复。**

1. 触发条件（任一）：检测到 hCaptcha / reCAPTCHA frame、发生导航到登录或 2FA 域、Cloudflare 挑战页、a11y 树无法匹配任何已知页面模板、动作连续失败 N 次、或动作被标记为敏感。
2. 交接动作：`win.show()` + `view.setBounds(全窗)` + `view.webContents.focus()` + `insertCSS` 横幅 + `executeJavaScriptInIsolatedWorld` 注入「我完成了 / 放弃」工具条。
3. 完成信号：① 工具条按钮 → `ipc-message`；② 站点探针（`/i/users/me` / 目标 a11y 节点）；③ 导航稳定 + a11y 谓词确认（**前两级优先，第三级只做兜底**）。
4. 恢复：重新 `attach`（若已 detach）→ **重取快照** → 重建代理上下文（丢弃页面级记忆，保留任务级记忆）→ **不重放旧动作**。
5. Wayland：不依赖 `setPosition`/抢焦点；靠「应用内明显的接管态」+ 系统通知。
6. **不自动过盾**：Cloudflare / hCaptcha 出现即交人工。

---

## 9. 证据与复现

**验证日期**：2026-09-26（UTC）。命令与来源如下，可原样复现。

### 9.1 本机实测（Fab）

```bash
# 裸请求 → 403 + cf-mitigated: challenge
curl -sIL https://www.fab.com/ | grep -iE '^HTTP|cf-mitigated|^server|accept-ch'

# 只补 UA 客户端提示 → 200
curl -s -o /dev/null -w '%{http_code}\n' \
  -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua: "Chromium";v="140", "Not=A?Brand";v="24"' \
  https://www.fab.com/

# 首页里加载了 hCaptcha
curl -s <同上的浏览器头组合> https://www.fab.com/ | grep -o 'js.hcaptcha.com[^"]*'
# → //js.hcaptcha.com/1/api.js?render=explicit&uj=true

# 内部 API
curl -s <同上> https://www.fab.com/ | strings | grep -oE '"/i/[a-z0-9/_-]+"' | sort -u
# → /i/users/me, /i/taxonomy/*, /i/layouts/homepage, /i/channels
```
环境：`curl 8.18.0`（x86_64-pc-linux-gnu，OpenSSL 3.5.5）。挑战页显示 `cType: 'managed'`。

### 9.2 官方文档

- Electron `session`：`session.fromPartition` 语义 / `session.fromPath` / `ses.getStoragePath()` / `ses.setUserAgent` / `ses.setProxy` / `setPermissionRequestHandler` — <https://www.electronjs.org/docs/latest/api/session>
- Electron `Cookies`：`flushStore()` 与「30 秒或 512 次操作」写盘 — <https://www.electronjs.org/docs/latest/api/cookies>
- Electron `webContents`：`executeJavaScript` / `executeJavaScriptInIsolatedWorld` / `insertCSS` / `focus()` / `setWindowOpenHandler` / `capturePage` / `sendInputEvent` / `ipc-message` / `did-navigate` / `dom-ready` / `did-stop-loading` / `login` — <https://www.electronjs.org/docs/latest/api/web-contents>
- Electron `Debugger`：`attach([protocolVersion])` / `sendCommand` / `isAttached` / `detach` 事件（DevTools 会踢线）— <https://www.electronjs.org/docs/latest/api/debugger>
- Electron `WebContentsView` / `BrowserView`（29 起弃用） / `View.setBounds` — <https://www.electronjs.org/docs/latest/api/web-contents-view> / <https://www.electronjs.org/docs/latest/api/browser-view>
- Electron `BrowserWindow`：Wayland 限制（定位/缩放/焦点/`showInactive`/`blur`）+ `--ozone-platform=x11` 退路 — <https://www.electronjs.org/docs/latest/api/browser-window>
- Electron `safeStorage`：Linux key provider（`org.freedesktop.portal.Secret`、Secret Service/KWallet、`--password-store`、`basic_text`）；同步 API 在 Electron 46 移除 — <https://www.electronjs.org/docs/latest/api/safe-storage>
- Electron `command-line-switches`：`--no-sandbox`（testing only）/ `--remote-debugging-port` 示例 — <https://www.electronjs.org/docs/latest/api/command-line-switches>
- Electron `sandbox` tutorial — <https://www.electronjs.org/docs/latest/tutorial/sandbox>
- Electron `app`：`app.setPath(name, path)` / `app.userAgentFallback` — <https://www.electronjs.org/docs/latest/api/app>
- Playwright `BrowserType`：`launchPersistentContext(userDataDir, options)`；**「automating the default Chrome user profile is not supported」** — <https://playwright.dev/docs/api/class-browsertype>
- Playwright `connectOverCDP`：「only supported for Chromium-based browsers」「significantly lower fidelity」 — 同上
- Playwright `Locator.ariaSnapshot({ mode, boxes, depth })`（v1.49+） — <https://playwright.dev/docs/api/class-locator>
- Playwright `toMatchAriaSnapshot`（v1.49+） — <https://playwright.dev/docs/api/class-locatorassertions>
- Playwright `_electron.launch()` / `electronApp.firstWindow()` / `evaluate()` — <https://playwright.dev/docs/api/class-electron>
- Playwright 认证 / `storageState` — <https://playwright.dev/docs/auth>
- Playwright mock & HAR：`page.route` / `route.fulfill` / `routeFromHAR` — <https://playwright.dev/docs/mock>
- Playwright 系统依赖 `npx playwright install-deps` — <https://playwright.dev/docs/browsers>
- Playwright 系统要求（Debian 12/13、Ubuntu 22.04/24.04/26.04） — <https://playwright.dev/docs/intro>
- Playwright Docker：`--ipc=host`、`--init`、user namespace seccomp — <https://playwright.dev/docs/docker>
- Chrome for Developers：**Chrome 136 起 `--remote-debugging-port` / `--remote-debugging-pipe` 不再作用于默认数据目录**（须配 `--user-data-dir`） — <https://developer.chrome.com/blog/remote-debugging-port>
- Chromium `docs/linux/password_storage.md`：`--password-store=basic` = plain text store；不可用时回退 `basic` — <https://chromium.googlesource.com/chromium/src/+/main/docs/linux/password_storage.md>
- Ubuntu 24.04 LTS release notes：**Unprivileged user namespace restrictions**（AppArmor 配合内核） — <https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890>
- CDP：`Accessibility.getFullAXTree` / `enable` / `queryAXTree`；`DOMSnapshot.captureSnapshot`；`DOM.querySelector`；`Page.captureScreenshot` / `startScreencast` / `setLifecycleEventsEnabled`；`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` — <https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json>
- MCP 规范 `2025-06-18` Elicitation — <https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation>

### 9.3 源码（一手）

- Electron `shell/browser/electron_browser_context.cc`：`MakePartitionName()` = `EscapePath(ToLowerASCII(input))`；`path_/Partitions/<name>` — <https://raw.githubusercontent.com/electron/electron/main/shell/browser/electron_browser_context.cc>
- Electron `shell/common/application_info.cc`：`BuildApplicationUserAgent()` → `"%s/%s Chrome/%s Electron/%s"` + `BuildUserAgentFromProduct(...)` — <https://raw.githubusercontent.com/electron/electron/main/shell/common/application_info.cc>
- Electron `shell/browser/electron_browser_client.cc`：`GetUserAgentMetadata()` → `embedder_support::GetUserAgentMetadata()`（**不读 `user_agent_override_`**） — <https://raw.githubusercontent.com/electron/electron/main/shell/browser/electron_browser_client.cc>
- Chromium `components/embedder_support/user_agent_utils.cc`：`GetUserAgentMetadata(bool only_low_entropy_ch)`，注释说明 UA override 与 UA-CH 的关系 — <https://raw.githubusercontent.com/chromium/chromium/main/components/embedder_support/user_agent_utils.cc>
- `releases.electronjs.org/releases.json`：Electron 44.4.5 → Chromium 152.0.7977.130 / Node 24.21.0
- Playwright `packages/playwright-core/browsers.json`（tag `v1.63.0`）：chromium build **1243**（`main` 分支当前为 1247）

### 9.4 第三方项目（活跃度，`gh api repos/<owner>/<repo>`，2026-09-26）

`Kaliiiiiiiiii-Vinyzu/patchright`（4,680★ / Apache-2.0 / 2026-09-13）、`browser-use/browser-use`（116,312★ / MIT / 2026-09-25）、`browserbase/stagehand`（25,394★ / MIT / 2026-09-25）、`microsoft/playwright-mcp`（37,572★ / Apache-2.0 / 2026-09-25）、`microsoft/playwright`（96,682★ / Apache-2.0 / 2026-09-26）、`Skyvern-AI/skyvern`（23,068★ / **AGPL-3.0**）、`lightpanda-io/browser`（35,577★ / **AGPL-3.0**）、`ultrafunkamsterdam/undetected-chromedriver`（12,854★ / **GPL-3.0** / **2025-07-05**）、`webllm/browser-use`（**14★** / MIT / 2026-07-16，与 Python 项目无关）。

Patchright 关键断言与自述通过清单 — <https://raw.githubusercontent.com/Kaliiiiiiiiii-Vinyzu/patchright/main/README.md>
browser-use CDP 用法 — <https://raw.githubusercontent.com/browser-use/browser-use/main/examples/browser/using_cdp.py>
browser-use `CaptchaWatchdog` / `StorageStateWatchdog` — `browser_use/browser/watchdogs/{captcha_watchdog,storage_state_watchdog}.py`
Stagehand `LocalBrowserConnectOptions = { cdpUrl, extensionId? }` — `packages/sdk-ts/src/clientSchemas.ts`；`launchLocalBrowser()` / `waitForChrome(cdpUrl)` — `packages/sdk-ts/src/browser/localBrowser.ts`
Playwright MCP `--cdp-endpoint` / `--extension` / a11y 定位 — <https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md>

---

## 10. 未能验证 / 开放问题

**共 14 项。**建议在 #7（自动化执行模型）与实现前用 spike 收敛前 3 项。

| # | 开放问题 | 为什么重要 | 建议验证方式 |
|---|---|---|---|
| 1 | **`playwright.chromium.connectOverCDP()` 能否稳定驱动 Electron 自带 `WebContentsView` 的目标？**（方案 D 的地基） | 决定「能不能既用 Electron 视图、又用 Playwright 生态」 | 写 20 行 spike：`app.commandLine.appendSwitch('remote-debugging-port','0')` → 读实际端口 → `curl 127.0.0.1:<port>/json/version` → `connectOverCDP` → `browser.contexts()[0].pages()` 找到视图页并 `ariaSnapshot()` |
| 2 | **Electron 内置 Chromium 在 Fab 上是否被 Cloudflare 真正放行**（不只是首页 200，而是登录后 `/i/users/me` 与 claim 流程全程） | 决定 A 是否成立；若被拒就要退到 Patchright | 手动开一个最小 Electron 壳，走一次真实登录 + claim，记录是否有挑战 |
| 3 | **Electron 默认 UA（含 `Electron/44.x`）是否被 Cloudflare 判定为可疑**；以及 `session.setUserAgent()` 覆盖后 UA ↔ UA-CH 不一致的实际后果 | §4.1 的实测提示「不一致会触发挑战」；源码显示 `GetUserAgentMetadata()` 不读 UA override | spike：分别测「默认 UA」「覆盖成纯 Chrome UA」「覆盖成与 Chromium 版本一致的 UA」三种情况下 `www.fab.com` 与 `/i/users/me` 的响应 |
| 4 | Fab 上 hCaptcha 的**实际出现点**（登录时？claim 时？还是仅风控触发时） | 决定 `needs_human` 的触发频率与 UX | 手动全流程记录一次 |
| 5 | Epic 账号的 2FA 形态（TOTP / 邮件 / 短信）与是否有「记住此设备」可长期免 2FA | 决定「登录一次长期复用」是否现实 | 手动登录一次并记录 |
| 6 | Fab 是否有**官方 API**（或 ToS 允许的自动化路径） | 若存在，应优先于浏览器自动化（可能让本方案大部分作废） | 查 Fab/Epic 开发者文档 + ToS 原文 |
| 7 | **cookie 的 `os_crypt` 密钥与 `safeStorage` 密钥是否同一把** | 决定「登录态落盘的保护强度」能不能依赖 safeStorage | 读 Electron 补丁与 Chromium `os_crypt` 源码；或实测：在有 keyring 的机器上换 keyring 口令看 cookie 是否失效 |
| 8 | cookie 文件在 partition 目录下的**确切子路径**（是否 `Network/Cookies`） | 排查/备份需要；但**不影响设计**（用 `cookies` API 即可） | 在真机上 `find $(ses.getStoragePath())` 一次 |
| 9 | **Patchright 在 `connectOverCDP` 场景下是否仍然有效**（关键补丁依赖「它自己启动浏览器」） | 决定「退路 B/D 是否需要 Patchright 自己托管浏览器」 | 读 `driver_patches/crDevToolsPatch.ts` 等；或实测同一站点两种启动方式 |
| 10 | Stagehand 是否有**一等公民的「暂停交人工」** API | 决定 §8.4 是「接 Stagehand 的钩子」还是「自己实现 + 让 Stagehand 不插手」 | 读 Stagehand SDK 文档/源码（`pause`/`resume`/`handoff`） |
| 11 | reCAPTCHA 是否被任一目标资产商店使用 | 影响适配器清单 | 逐站点实测 |
| 12 | `--ozone-platform=x11`（Xwayland）对 Electron 应用在这类桌面上的实际副作用 | 决定它能不能当「用户可开开关」 | 在 Ubuntu 24.04/GNOME Wayland 上实测窗口行为 |
| 13 | Ubuntu 24.04+ AppArmor userns 限制下，本项目打包的 Electron 应用**具体**需要什么（AppArmor profile？SUID helper？） | 决定安装/首启是否可用（这是「装完打不开」级别的问题） | 在 Ubuntu 24.04 上装一次 `.deb` 实测 |
| 14 | 「无头环境」下 Electron 是否必须 `xvfb-run` | 决定 CI 形状 | CI 里实测 |

另有 2 项**非技术**依赖，需人工确认（不属本研究范围）：Fab / Epic 的 **ToS 与 robots** 对自动化 claim 的表述（对应 issue #2 / #10），以及「用户自己账号 + 自己资产」这一前提是否足以支撑自动化 claim 的合规性。
