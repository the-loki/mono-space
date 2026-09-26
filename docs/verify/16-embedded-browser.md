# #16 验证：Electron 内嵌浏览器方案能否成立（Fab 全程放行 + 生成的扩展可加载可通信 + UA）

- **票据**：`the-loki/mono-space#16`（Part of #1，标签 `wayfinder:task`）
- **日期**：2026-09-26（UTC）
- **验证方式**：最小 Electron 壳实证（代码在 `/tmp/ms-spike-16/`，非仓库内容；仓库只新增本报告）
- **环境**：

| 项 | 值 |
|---|---|
| OS | Ubuntu 26.04.1 LTS（`Linux 7.0.0-34-generic`, x86_64） |
| Electron | `44.4.5`（Chromium **152.0.7977.130** / Node **24.21.0** / V8 15.2.124.28-electron.0） |
| node / pnpm | `v24.20.0` / `10.17.1` |
| 显示 | `DISPLAY=:198`（Xvfb 1600x1000x24，无 xvfb-run）；启动参数 `--no-sandbox` |
| 出口 IP | `174.137.59.3`（共享/云出口，**非住宅 IP**，结论外推需注意） |
| Cloudflare 行为 | managed challenge（Turnstile，`cf-mitigated: challenge`）；**有状态评分，单次请求样本不可靠**（见 §1 方法与 §4） |

## 结论速览

| # | 验证项 | 结论 |
|---|---|---|
| 1 | Electron 内置 Chromium 在 Fab 上被 Cloudflare 放行（未登录） | **有条件成立**：默认 Electron **必被 challenge**；补齐 `Sec-CH-UA` 后 **200 稳定放行**。登录态全程 = **HITL 未验证** |
| 2 | 生成的 MV3 扩展可装进应用私有 `persist:` 会话 | **成立**（MV3 + SW + content script + popup 全跑通；`chrome.*` 矩阵见 §2） |
| 3 | 扩展↔应用通信通道 + 运行期热替换 | **成立**（content→SW `sendMessage`；扩展→主进程 3 条通道；两条热替换路径均通） |
| 4 | Electron 默认 UA 可疑 + 覆盖后果 | **成立**：根因不是 UA 字符串，而是 **Electron 默认完全不发 `Sec-CH-UA` 客户端提示**；`setUserAgent()` 单独覆盖会造成 UA↔UA-CH 分叉且**不解决** challenge |

---

## 1. Electron 内置 Chromium 在 Fab 上是否被 Cloudflare 放行（未登录部分）

### 结论

**有条件成立。**
- **默认配置下不成立**：`BrowserWindow` + `persist:` 分区、Electron 默认 UA（含 `Electron/44.4.5`）访问 `https://www.fab.com/`、`https://www.epicgames.com/account/code-redemption`、`https://www.fab.com/i/users/me`，**稳定拿到 `403 cf-mitigated: challenge`**（managed challenge / Turnstile）。
- **补齐 `Sec-CH-UA` 家族客户端提示后成立**：在 `session.webRequest.onBeforeSendHeaders` 注入 `sec-ch-ua`（+ `sec-ch-ua-platform`/`-mobile`）后，**Fab 首页 200 稳定放行，完整 SPA 加载（2.3 MB HTML，title "Fab"）**；`/i/users/me` 也放行，返回 Fab 的 `401 {"detail":"身份认证信息未提供。"}`（未登录的**正常业务响应**，正是计划中的登录态探针）。
- **登录态下的 `/i/users/me` 200 与一次真实 claim 全程：未验证（需人工登录，见 HITL 残差）。**

### 步骤

1. 最小壳：`BrowserWindow`（`show:false`），`webPreferences.session = session.fromPartition('persist:probe')`，逐个 `loadURL`，用 `session.webRequest.onHeadersReceived` 记录主文档状态与 `cf-mitigated`，加载后 `executeJavaScript` 读 `document.title` / challenge 标记（`script[src*=challenge-platform]`、`#challenge-platform`、`window.__cf_chl_opt`）/ 内联脚本。
2. 用 `curl` 在同一出口 IP 复跑 §9.1 的对照（裸请求 / 只加 `sec-ch-ua`）。
3. **A/B 对照（消除 Cloudflare 有状态性）**：以 `default`（默认）与 `ch`（注入 `sec-ch-ua`）**交替**跑 4 轮，每轮独立 `persist:` 分区（全新 cookie jar），记录首响应状态。
4. **`navigator.userAgentData` 与真实出网头**：用本地自签名 TLS 回显 + `httpbin.org/headers` 读取 Electron **实际发出的** `Sec-CH-*` 头（见 §4）。

### 原始输出

默认 Electron UA，三个目标（第 1 轮，`main1.js`）：

```text
=== PROBE https://www.fab.com/ ===
  title: 请稍候…   finalUrl: https://www.fab.com/
  markers: hasChallengePlatform=true  bodyText="再进行一步操作 请完成安全检查以继续 会话 ID: …"
  scripts: https://www.fab.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=…
           https://challenges.cloudflare.com/turnstile/v0/b/d76008a69eab/api.js?onload=…&render=explicit
  mainFrame: statusCode=403  cf-mitigated=["challenge"]  server=["cloudflare"]
             accept-ch=Sec-CH-UA-Bitness, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version, …
  ua: Mozilla/5.0 (X11; Linux x86_64) … Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36

=== PROBE https://www.epicgames.com/account/code-redemption ===
  title: 请稍候…   mainFrame: statusCode=403  cf-mitigated=["challenge"]

=== PROBE https://www.fab.com/i/users/me ===
  title: fab.com/i/users/me   bodyText={"detail":"身份认证信息未提供。"}
  mainFrame: statusCode=401  server=["cloudflare"]  content-type=["application/json"]   ← 未被 challenge
```

同 IP 的 `curl` 对照（§9.1 复现）：

```text
--- 1 bare curl
HTTP/2 403
cf-mitigated: challenge
--- 6 sec-ch-ua only (no UA override)
HTTP/2 403
--- 2 pure Chrome140 UA + sec-ch-ua140 + sec-fetch
HTTP/2 200
```

关键 A/B（同一出口 IP、交替 4 轮、独立分区）：

```text
seq#1 default trial1: status=403 passed=false (13823ms) title="请稍候…"
seq#2 ch      trial1: status=200 passed=true  (13870ms) title="Fab"
seq#3 default trial2: status=403 passed=false (13645ms) title="请稍候…"
seq#4 ch      trial2: status=200 passed=true  (21982ms) title="Fab"
seq#5 default trial3: status=403 passed=false (14126ms) title="请稍候…"
seq#6 ch      trial3: status=200 passed=true  (13658ms) title="Fab"
seq#7 default trial4: status=403 passed=false (13183ms) title="请稍候…"
seq#8 ch      trial4: status=200 passed=true  (14285ms) title="Fab"

SUMMARY default : passed 0/4
SUMMARY forced-CH: passed 4/4
```

`/i/users/me` 登录态探针可达性（交替 3 轮）：

```text
default t1: status=403 cf-mitigated=["challenge"] body="再进行一步操作 请完成安全检查以继续 …"
ch      t1: status=401 cf-mitigated=undefined     body="{"detail":"身份认证信息未提供。"}"
default t2: status=403 …      ch t2: status=401 …
default t3: status=403 …      ch t3: status=401 …
```

> **状态性说明**：Cloudflare managed challenge 是**有状态/非独立**的——单次请求甚至同一条命令重跑会出现 200/403 抖动（本 spike 观察到过「同一默认 UA 一次 200、随后连续 9 次 403」）。因此**只有交替 A/B 的统计结果可采信**：`default 0/4` vs `ch 4/4`，并已在 §4 用「实际出网头」解释因果。

### 对 #12 / #13 / #9 / ADR-0001 的含义

- **#12（Fab 兑换流程形态/状态机）**：`/i/users/me` 这个登录态探针可复用，但它**必须在「补齐 client hints」的 session 上执行**，否则探针本身会被 challenge（403）而无法区分「未登录」与「被拦」；`needs_human` 的触发点不变。
- **#13（工具契约与权限模型）**：任何「读取 Fab 页面 / 驱动 Fab」的工具都依赖同一份可放行的 session；这把「补 client hints」从优化项升级为**执行前置条件**。
- **#9（内置 Pi 代理能力边界）**：代理能看到 Fab，前提是宿主 session 已修复；「代理只当脚本作者、产出扩展」的模型不受本项影响。
- **ADR-0001**：**未推翻**。主方案（Electron 自带 Chromium + 私有 `persist:` 会话）仍成立，但新增一条硬约束：**出网必须补齐 `Sec-CH-UA` 客户端提示**（Electron 默认不发，见 §4）。

---

## 2. 生成的浏览器扩展能否装进应用私有会话

### 结论

**成立。**
- `session.fromPartition('persist:ext-main').extensions.loadExtension(path, { allowFileAccess: true })` 在 **`persist:` 分区**上加载自建 **Manifest V3** 扩展成功（`manifest_version: 3`）。
- 扩展的 **service worker 真实运行**（`chrome-extension://<id>/sw.js`，scope `chrome-extension://<id>/`），**content script 在 `http://127.0.0.1` 与真实 `https://example.com` 上都注入执行**，**popup 可加载**。
- **`chrome.*` API 只实现子集**，实测矩阵见下；官方支持清单见 <https://www.electronjs.org/docs/latest/api/extensions>（"Supported Extensions APIs" 段）。
- 官方 API（Electron 44）：**`ses.extensions.loadExtension()` 是新 API**；`ses.loadExtension()` / `ses.getAllExtensions()` / `ses.removeExtension()` 已标记 **Deprecated**。`ses.extensions` 提供 `extension-loaded` / `extension-ready` / `extension-unloaded` 事件。加载进**内存（非 persist）session 会抛错**——即 `persist:` 是硬要求（与票据一致）。类型定义：`node_modules/electron/electron.d.ts` 的 `class Extensions` / `interface LoadExtensionOptions` / `interface Extension`。

### 步骤

1. 自建 MV3 扩展 `/tmp/ms-spike-16/ext-mv3/`：`manifest.json`（`background.service_worker`、`content_scripts`、`action.default_popup`）、`sw.js`（API 矩阵 + 消息处理）、`content.js`、`popup.html` + `popup.js`。
2. `persist:ext-main` 上 `ses.extensions.loadExtension(...)`；监听 `ses.extensions.*` 与 `ses.serviceWorkers.*` 事件。
3. 打开本地页与 `https://example.com/`，用 `executeJavaScript` 读 content script 写入的 DOM 标记；加载 `chrome-extension://<id>/popup.html` 读标题。
4. 在 **SW 内**对 29 个 `chrome.*` 命名空间做 `typeof` 存在性 + 一次无害调用，经消息通道取回（见 §3）。

### 原始输出

```text
=== STEP loadExtension v1.0 ===
  ext: {"id":"fndpmikfoiiffnebgjnbccmehddacmkj","name":"spike16-mv3","version":"1.0",
        "url":"chrome-extension://fndpmikfoiiffnebgjnbccmehddacmkj/","mv":3}
  loadErr: null
  getAllExtensions: [{"id":"fndpmikfoiiffnebgjnbccmehddacmkj","version":"1.0"}]
  serviceWorkers.getAllRunning: {"0":{"scriptUrl":"chrome-extension://…/sw.js",
        "scope":"chrome-extension://…/","renderProcessId":5}}
(node) ExtensionLoadWarning: Warnings loading extension:
  Permission 'cookies' is unknown.
  Permission 'notifications' is unknown.
  Permission 'contextMenus' is unknown.

=== 服务 worker 生命周期（ses.serviceWorkers 事件） ===
["status","{\"versionId\":0,\"runningStatus\":\"starting\"}"]
["registered","{\"scope\":\"chrome-extension://…/\"}"]
["status","{\"versionId\":0,\"runningStatus\":\"running\"}"]
（热替换时依次出现 versionId 1、2 —— 见 §3）

=== SW 内 console（证明 SW 执行 + MV3 解析） ===
SW_START {"id":"fndpmikfoiiffnebgjnbccmehddacmkj","manifestVersion":3,"version":"1.0"}
SW_START {"id":"…","manifestVersion":3,"version":"1.1"}
SW_START {"id":"…","manifestVersion":3,"version":"1.2"}

=== content script 注入 ===
[local-http] http://127.0.0.1:8791/page -> {"cs":"CS_V1_0-mv1.0","cmd":"ready","hasReport":true,"title":"local-page"}
[real-https] https://example.com/        -> {"cs":"CS_V1_0-mv1.0","cmd":"ready","hasReport":true,"title":"Example Domain"}
=== popup === chrome-extension://…/popup.html -> popup-mv1.0
```

**`chrome.*` API 实测矩阵**（`persist:` 分区、MV3 service worker、manifest 声明了 storage/scripting/tabs/alarms/cookies/notifications/contextMenus/idle/webRequest/declarativeNetRequest + `<all_urls>`；`management` 二次补测）：

| API | Electron 44 实测 | 官方支持清单 | 说明 |
|---|---|---|---|
| `chrome.runtime` | ✅ | ✅ | `getManifest().manifest_version=3`、`id`、`sendMessage`/`onMessage`、`reload` 实测可用；**`connectNative` 不存在（false）**；`getURL`/`getPlatformInfo` 未单独测 |
| `chrome.storage` | ✅ | ✅（仅 `.local`） | `local.set/get` 往返成功；**`.sync` / `.managed` 文档明说不支持** |
| `chrome.scripting` | ✅ | ✅（全部） | `getRegisteredContentScripts()` 可用 |
| `chrome.tabs` | ✅（部分） | ✅（部分） | `query()` 可用（count=1）；文档：`-1` tabId 不支持 |
| `chrome.webRequest` | ✅ | ✅（全部） | 注册/注销 listener 成功；**Electron 的 `session.webRequest` 优先级更高** |
| `chrome.extension` | ✅（仅存在性） | ✅ | 只验证了命名空间存在，`getURL`/`getBackgroundPage` 未单独测 |
| `chrome.devtools.*` | 未测（需 devtools 页） | ✅ | inspectedWindow / network / panels |
| `chrome.management` | ⚠️ 命名空间在，但 **`getAll` 不是函数** | ✅（文档列了 `getAll`） | **与官方文档不符**；补声明 `management` 权限后仍如此 |
| `chrome.declarativeNetRequest` | ✅（可用，非官方） | ❌ 未列 | `getDynamicRules()` 可用；官方称未列 API 属 **provisional** |
| `chrome.alarms` | ✅（可用，非官方） | ❌ 未列 | `create`/`get`/`clear` 可用 |
| `chrome.idle` | ✅（可用，非官方） | ❌ 未列 | `queryState(60)` → `active` |
| `chrome.i18n` | ✅（可用，非官方） | ❌ 未列 | `getMessage()` → `""` |
| `chrome.action` | ✅（可用，非官方） | ❌ 未列 | `setBadgeText()` 成功 |
| `chrome.permissions` | ❌ 不存在 | ❌ 未列 | — |
| `chrome.windows` | ❌ 不存在 | ❌ 未列 | MV3 SW 内不可用 |
| `chrome.cookies` | ❌ 不存在 | ❌ 未列 | 权限被报告为 `unknown` |
| `chrome.notifications` | ❌ 不存在 | ❌ 未列 | 权限被报告为 `unknown` |
| `chrome.contextMenus` | ❌ 不存在 | ❌ 未列 | 权限被报告为 `unknown` |
| `chrome.nativeMessaging` | ❌ 不存在 | ❌ 未列 | `chrome.runtime.connectNative` 也不存在 → **native messaging 整条路不可用** |
| `webNavigation` / `history` / `bookmarks` / `downloads` / `topSites` / `search` / `tts` / `omnibox` / `offscreen` / `sidePanel` / `declarativeContent` | ❌ 均不存在 | ❌ 未列 | — |

> 官方原文（同一页）：「We support the following extensions APIs, with some caveats. **Other APIs may additionally be supported, but support for any APIs not listed here is provisional and may be removed.**」——`alarms`/`idle`/`i18n`/`action`/`declarativeNetRequest` 正落在这条「provisional」区间，**可跑但不可依赖**。

### 对 #12 / #13 / #9 / ADR-0001 的含义

- **#12**：「代理产出扩展、日常执行走扩展」在 MV3 + `persist:` 分区上可落地；但扩展侧**不能**用 `cookies`/`windows`/`contextMenus`/`notifications`/`permissions`，相关能力必须由**主进程原生 API** 提供。
- **#13**：工具清单里若出现依赖上述缺失 API 的项（如读 cookie、开窗口、右键菜单），要么删掉，要么改由主进程执行；`nativeMessaging` 不可用意味着**不能用 native messaging 做代理↔UI 桥**。
- **#9**：确认「内置 Pi 代理只当脚本作者、产出物是扩展」的模型技术上成立（MV3 可加载、SW 可跑）。
- **ADR-0001**：不冲突——ADR 排除的是「运行时第二套 Chromium」，而这里用的是 **Electron 自带 Chromium** 的扩展能力，正落在 ADR 允许范围内。

---

## 3. 扩展↔应用通信通道 + 运行期热替换

### 结论

**成立。** 实测到多条可用通道，并验证了两条热替换路径。

**通信通道（全部实测通过）：**

| 通道 | 方向 | 实测 | 机制 |
|---|---|---|---|
| (a) `chrome.runtime.sendMessage` | content script → SW | ✅ | SW `onMessage` 返回矩阵，content script 收到 `ok:true, err:null` |
| (b) preload + `window.postMessage` + `ipcRenderer` | 扩展页面 → 主进程 | ✅ | content script `postMessage` → preload `ipcRenderer.send` → 主进程 `ipcMain.on`（收到 2 条） |
| (b') 扩展 → 应用本地 HTTP 端点 | 扩展 → 主进程 | ✅ | content script `fetch('http://127.0.0.1:PORT/report')`（仅 http 页；https 页受 mixed-content 限制） |
| (b'') CDP `webContents.debugger` + `Runtime.addBinding` | 扩展页面 → 主进程 | ✅ | 主进程 `attach`+`Runtime.addBinding`，content script `postMessage` → 主世界监听 → binding → `Runtime.bindingCalled` |
| (c) SW → 主进程（直接） | SW → 主进程 | ❌ | `chrome.nativeMessaging`/`connectNative` 不存在；`ServiceWorkerMain.send()` 存在但**扩展 SW 内无 `require`/`ipcRenderer`**，无法接收 |

> 关键细节：Electron `debugger` 的 `message` 事件签名是 **`(event, method, params, sessionId)`**（不是 `(event, params)`）。用错签名会表现为「binding 调用成功但收不到事件」。另外 `Runtime.addBinding` 在**导航前**注入的监听器会随文档销毁，需用 `Page.addScriptToEvaluateOnNewDocument` 在每次新文档注入。

**热替换（两条路径均通过，不重启应用）：**

| 路径 | 结果 |
|---|---|
| 改磁盘文件 → `ses.extensions.removeExtension(id)` → 重新 `ses.extensions.loadExtension(path)` | ✅ `afterRemove: []` → 新版本 `1.1` → content script 标记变 `CS_V1_1-mv1.1` |
| 改磁盘文件 → SW 调 `chrome.runtime.reload()`（经 content script 触发） | ✅ 标记变 `CS_V1_2-mv1.2`，且 `serviceWorkers` 事件出现 `versionId:2 running` |

> 前提（Electron 官方 d.ts 明说）：**扩展必须每次启动都 `loadExtension`**（不再自动持久）；**不能加载打包 `.crx`**；**不能装进内存 session**。热替换后**扩展 id 不变**（同一磁盘路径推导），便于主进程持有引用。

### 步骤

1. content script 在 `document_idle` 用 `chrome.runtime.sendMessage({cmd:'matrix'})` 请求 SW，SW 回传矩阵；content script 把结果同时（i）写入 DOM 属性、（ii）`window.postMessage`、（iii）`fetch` 到本地端点。
2. 主进程三路收取：`ipcMain`（经 preload）、本地 `http` server、以及 CDP `Runtime.addBinding`。
3. 热替换两条路径分别改磁盘 + `removeExtension`+`loadExtension` / `chrome.runtime.reload()`，再重载页面读 DOM 标记。

### 原始输出

```text
=== STEP channel reports ===
  ipcReports: 2 | httpReports: 1
  report.ok: true | err: null | swInfo.env: {"require":"undefined","process":"undefined",
      "module":"undefined","ipcRenderer":"err: require is not defined"}
=== STEP ServiceWorkerMain ===
  {"versionId":0,"scope":"chrome-extension://…/","scriptURL":"chrome-extension://…/sw.js",
   "hasWorker":true,"sent":true}          ← send() 不抛错，但 SW 无 ipcRenderer 可接收
=== STEP hot swap: removeExtension + loadExtension ===
  [after-remove+load] …/page -> {"cs":"CS_V1_1-mv1.1", …}
  afterRemove: [] | ext2: 1.1 err2: null
=== STEP hot swap: chrome.runtime.reload() ===
  [after-runtime.reload] …/page -> {"cs":"CS_V1_2-mv1.2", …}
  preReload: posted | reloadFlag: 1790398611531 | marker: CS_V1_2-mv1.2

=== ses.extensions 生命周期事件（热替换证据） ===
  ["loaded","fndpmik…","1.0"], ["ready","…","1.0"], ["unloaded","…","1.0"],
  ["loaded","…","1.1"], ["ready","…","1.1"], ["unloaded","…","1.1"],
  ["loaded","…","1.2"], ["ready","…","1.2"]

=== CDP Runtime.addBinding 通道 ===
  typeof __spike16Cdp in page: function
  manual call result: called
  CDP bindingCalled count: 2
    {"via":"cdp-binding","channel":"content -> SW via chrome.runtime.sendMessage","marker":"CS_V1_2"}
    manual-test
  RESULT CDP channel WORKS
```

### 对 #12 / #13 / #9 / ADR-0001 的含义

- **#12**：扩展可作为「执行器」，用 (a)+(b) 把「领取完成 / 需人工 / 中间状态」事件回流给应用状态机；热替换让流程脚本可迭代而不必重启应用。
- **#13**：`ask_human` 等协议**不能走 native messaging**（不可用）；推荐 **content→SW `sendMessage` + preload/IPC 或 CDP binding** 作为代理↔UI 桥。CDP binding 与 `webContents.debugger` 也顺带验证了研究 §8.1 里「CDP 直驱页面」的可行性（`Runtime.evaluate`/`DOM.getDocument` 均正常）。
- **#9**：热替换成立 = 「代理持续改进脚本」有技术支撑，`#9` 关于「代理产出物」的假设成立。
- **ADR-0001**：一致。ADR 未规定扩展↔应用桥的形态，本节给出可直接落地的候选集。

---

## 4. Electron 默认 UA 是否可疑 + 覆盖后果

### 结论

**成立（默认配置确实会被 Cloudflare 判定可疑；但根因不是 UA 字符串，而是「Electron 默认根本不发 `Sec-CH-UA` 客户端提示」）。**

1. **Electron 默认在网络上完全不发 `Sec-CH-UA*` 头。** 用本地自签名 TLS 回显（含 `Accept-CH` 高熵提示 opt-in）与 `httpbin.org/headers` 双重确认：请求里只有 `user-agent` 与 `sec-fetch-*`，**没有任何 `sec-ch-ua` / `sec-ch-ua-platform` / `sec-ch-ua-mobile` / 高熵提示**。而 `navigator.userAgentData` 在渲染进程**存在**——即 **JS 可见的 UA-CH 与网络层 UA-CH 不一致**（网络层为空）。这是与真实 Chrome 的**实质分叉**，也正是 §4.1「缺失 client hints 会被 challenge」命中的信号。
2. **`session.setUserAgent()` 只改 UA 字符串，不改 `navigator.userAgentData`**，也**不恢复**缺失的网络层 `Sec-CH-UA` 头。所以「覆盖成纯 Chrome UA」既制造 UA↔UA-CH 分叉，又**仍然被 challenge**。
3. **Electron 的 `navigator.userAgentData.brands` 永远只有 `Chromium`，没有 `Google Chrome` 品牌**（Chromium-only branding），`setUserAgent` 也改不了。若伪装成 Chrome，这是 JS 侧可检测的固定分叉。
4. **修复方式经实测有效**：在 `session.webRequest.onBeforeSendHeaders` 注入 `sec-ch-ua`（任意品牌即可，`"Chromium";v="152"` 与 `"Google Chrome";v="152"` 效果相同）→ Fab **200 稳定放行**（§1 的 `ch 4/4`）。
5. **三种 UA 模式的 Fab 结果**：默认 / 纯 Chrome UA 覆盖 / 仅注入 UA-CH 不改 UA——**前两者仍 403**，只有**补齐 `Sec-CH-UA` 才 200**。即「UA 覆盖与否」不是决定变量，**client hints 的在/缺才是**。

### 步骤

1. 本地 TLS 回显服务器（自签名证书 + `setCertificateVerifyProc` 放行）响应 `Accept-CH: Sec-CH-UA-Full-Version-List, …`，连续两次导航，打印第二次请求的全部 `sec-*` 头。
2. `httpbin.org/headers` 交叉验证；`executeJavaScript` 读 `navigator.userAgent` / `navigator.userAgentData.brands` / `getHighEntropyValues([...])` / `navigator.platform` / `navigator.webdriver`。
3. 三种配置跑 Fab（每个 2 轮独立分区）+ 交替对照（`default` / `sec-ch-ua=Chromium` / `sec-ch-ua=GoogleChrome`）。

### 原始输出

**（决定性）Electron 实际发出的请求头**——本地 TLS 回显，服务端已发 `Accept-CH`：

```text
=== request /first ===
  user-agent: Mozilla/5.0 (X11; Linux x86_64) … Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36
  sec-fetch-site: none
  sec-fetch-mode: navigate
  sec-fetch-user: ?1
  sec-fetch-dest: document
  accept-language: zh-CN
=== request /second ===   ← 已 opt-in 高熵提示，仍然没有 sec-ch-ua*
  user-agent: … Electron/44.4.5 …
  sec-fetch-site: none
  sec-fetch-mode: navigate
  sec-fetch-user: ?1
  sec-fetch-dest: document
  accept-language: zh-CN
```

`httpbin.org/headers` 交叉验证（默认配置）：无 `Sec-Ch-Ua` / `Sec-Ch-Ua-Platform`（返回里只有 `Sec-Fetch-*` 与 `User-Agent`）。

**UA ↔ UA-CH 分叉矩阵**（渲染进程 JS 视角；四种配置）：

| 配置 | `navigator.userAgent` | `userAgentData.brands` | `uaFullVersion` / `platform` | 网络 `Sec-CH-UA` | Fab |
|---|---|---|---|---|---|
| C0 默认 | `… Chrome/152.0.7977.130 Electron/44.4.5 …` | `Not?A_Brand 24`, `Chromium 152` | `152.0.7977.130` / `Linux` | **（无）** | 403 ×2 |
| C1 `setUserAgent(纯 Chrome 152)` | `… Chrome/152.0.7977.130 …`（无 Electron 令牌） | **不变**：`Chromium 152`（无 Google Chrome） | 同 C0 | **（无）** | 403 ×2 |
| C2 默认 UA + 注入 `sec-ch-ua`=GoogleChrome | 同 C0 | 同 C0（**分叉**） | 同 C0 | `"Google Chrome";v="152", "Chromium";v="152", "Not=A?Brand";v="24"` | **200 ×2** |
| C3 纯 Chrome UA + 注入 `sec-ch-ua` | 同 C1 | 同 C0（**分叉**） | 同 C0 | 同 C2 | **200 ×2** |

最小头对照（交替，独立分区）：

```text
none        t1: status=403 passed=false    none        t2: status=403 passed=false
chChromium  t1: status=200 passed=true     chChromium  t2: status=200 passed=true   ← 只要 sec-ch-ua 在
chGoogle    t1: status=200 passed=true     chGoogle    t2: status=200 passed=true
SUMMARY none: 0/2   chChromium: 2/2   chGoogle: 2/2
```

`getHighEntropyValues([...])`（默认，C0/C1/C2/C3 相同）：

```json
{"architecture":"x86","bitness":"64",
 "brands":[{"brand":"Not?A_Brand","version":"24"},{"brand":"Chromium","version":"152"}],
 "fullVersionList":[{"brand":"Not?A_Brand","version":"24.0.0.0"},{"brand":"Chromium","version":"152.0.7977.130"}],
 "mobile":false,"platform":"Linux","platformVersion":"","uaFullVersion":"152.0.7977.130"}
```

`navigator.webdriver` = `false`（Electron 默认不暴露 webdriver 标记）；`--enable-features=UserAgentClientHint,...` 等开关**未能**让 Electron 发出 client hints（试了 3 组 feature flag，均无 `Sec-CH-UA`）。

### 对 #12 / #13 / #9 / ADR-0001 的含义

- **#12**：**不要只改 UA**。任何「伪装成 Chrome」的做法都会留下 UA↔UA-CH 分叉（且默认 UA 字符串里的 `Electron/44.4.5` 本身也可能被单独识别，本 spike 不能排除）；正确做法是**成组补齐 client hints**，UA 串保持或按需覆盖。
- **#13**：若代理生成的脚本发起自定义请求（`fetch`/`XMLHttpRequest`），也会继承「无 `Sec-CH-UA`」这一特征；需要跨站读写的工具要意识到可能被 Cloudflare 拦。
- **#9**：模型若依据 `navigator.userAgentData` 判断浏览器身份，拿到的永远是 `Chromium`-only brands，**不能**据此推断「我在真 Chrome 里」。
- **ADR-0001**：**强化**「用真实 Electron Chromium」的决定（真实 TLS/JA 指纹 + 真实 JS 引擎），但附带实现层义务：**必须补齐 client hints**。

---

## HITL 残差

以下项**必须人工登录**才能完成，本次**未验证**，不得据此下结论：

1. **登录态下 `/i/users/me` 返回 200。**
   - 拿到登录态后要测：在「补齐 `Sec-CH-UA`」的 `persist:` session 上手动登录 Epic/Fab（含 hCaptcha/2FA）→ 访问 `https://www.fab.com/i/users/me`。
   - 预期看：**HTTP 200 + 用户 JSON**（而非 401 或 403 challenge）；并确认 `session.cookies.get({name:'cf_clearance'})` 与 `__cf_bm` 等在登录后仍有效，且**后续页面导航不再被 challenge**。
2. **一次真实 claim 全流程。**
   - 要测：在已登录 session 里完成一次 Fab 领取（筛选 → claim → 确认），全程记录是否出现 Cloudflare challenge / Turnstile / hCaptcha，以及出现点。
   - 预期看：**全程无 challenge**；若出现 Turnstile/hCaptcha，即为 `needs_human` 的一等触发点（对应研究 §4.2 / §6）。
3. **hCaptcha 的实际出现点**（登录时？claim 时？仅风控触发？）。
4. **Epic 2FA 形态**（TOTP / 邮件 / 短信）与是否有「记住设备」以长期免 2FA。
5. **登录态下 client hints 修复是否仍然必要且充分**：本次只在**未登录**证明了「不补 CH → 403，补 CH → 200」。登录后（带 `cf_clearance`）是否仍需补 CH、以及补 CH 后 `cf_clearance` 的存活期，均**未验证**。
6. **`/i/users/me` 之外的真实业务写接口**（claim POST）在补齐 CH 后是否被放行——这直接决定 ADR-0001 的「写操作走内嵌浏览器」是否成立。

> 说明：本次**出口 IP 为共享云 IP**（`174.137.59.3`），Cloudflare 评分偏严且抖动。真实用户的住宅 IP 可能**更宽松**；因此「默认必被 challenge」这一结论**可能高估**了真实环境下的拦截率，但「Electron 不发 Sec-CH-UA」是**与 IP 无关的确定性事实**，修复方向不变。

---

## 对 ADR-0001 的判断

**第 1 项未推翻主方案。** 基于**未登录**证据只能给出「**未推翻 / 存疑**」：

- 未登录证据显示，Electron 默认被 challenge 的**可观测根因是「Electron 不发 `Sec-CH-UA` 客户端提示」**，而这不是不可逾越的指纹墙——`session.webRequest.onBeforeSendHeaders` 注入该头后，**Fab 首页与 `/i/users/me` 均稳定放行（交替对照 4/4、3/3）**。因此**主方案（Electron 自带 Chromium + 私有 `persist:` 会话）继续成立**，但必须补一条实现约束：**所有 store session 的出网必须补齐 `Sec-CH-UA` 家族头**（这应由 session 级中间件统一注入，而非散落各处）。
- **存疑项**：登录态下的 `/i/users/me` 与**一次真实 claim 写操作**是否全程放行，**尚未验证**（HITL）。若登录后写操作仍被 Cloudflare 拦（例如要求 Turnstile 交互或指纹更深层的分叉），才需要按 §2.3 退路评估 Patchright 自托管浏览器，并相应修订 ADR-0001 与 `#12`/`#13`。
- 因此建议：**不修订 ADR-0001 的主方案选择**，仅在实现约束里追加「补齐 client hints」；把「登录态写操作全程放行」保留为 HITL 待验项，由人工登录后回填。

---

## 复现说明

- spike 工程：`/tmp/ms-spike-16/`（未提交）。关键脚本：`main1.js`（#1 探测）、`main_ab.js`/`main_ab2.js`（#1/#4 交替对照）、`main_tls.js`/`main_echo.js`（实际出网头）、`main23.js`（#2/#3）、`main_cdp2.js`（CDP 通道）、`main_final.js`（版本 + `/i/users/me`）。
- 运行：`DISPLAY=:198 ./node_modules/.bin/electron --no-sandbox <script>.js`。
- 原始 JSON：`out1.json` / `out_ab.json` / `out4b.json` / `out23.json` / `out_matrix2.json` / `out_me.json`。
- 官方文档：扩展 API 支持清单 <https://www.electronjs.org/docs/latest/api/extensions>；`session.extensions` <https://www.electronjs.org/docs/latest/api/session>；`ServiceWorkerMain` <https://www.electronjs.org/docs/latest/api/service-worker-main>；`Chrome` 品牌 / client hints 说明见研究 §9.2–§9.3。
