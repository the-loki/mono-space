---
status: accepted
票据: the-loki/mono-space#13（Part of #1）
类型: wayfinder 决策票（grilling）——本文件即结清记录
---

# 内置 Pi 代理的工具契约与权限模型

**⚠️ 状态（2026-09-27 复核）：本文是历史结清记录，工具面已被后续决定重写过。**

保留原文以免丢失当时的推理，但**不要把下面 §1 的工具表当成现行契约**。现行契约的唯一来源是代码：
`src/main/agent/tools.ts`（领域 8 个）+ `src/main/agent/tools-browser.ts`（浏览器 6 个），
共 **14** 个工具（本文写的是 10 个）。逐条更新（2026-09-27 复核）：

| 本文当时的写法 | 现在是什么 | 由谁推翻 |
| --- | --- | --- |
| 工具经 **MCP** 暴露 | **MCP 整个移除**，Pi 直接内嵌进 MonoSpace，工具由主进程注入 | `#31` + 用户决策；落地见提交 `e4fc264`（内嵌 Pi、移除 MCP）与 `src/main/agent/tools.ts` 顶部注释 |
| 工具名 `snapshot_page` / `page_screenshot` / … | 一律 **`monospace_` 前缀**（避免与其它浏览器 MCP 冲突）；浏览器工具**融合为 5 个**：`dom` / `screenshot` / `script` / `act` / `errors` | 同上 |
| 浏览器工具带 `pageId` | **不再有 `pageId`**：一律作用于「当前打开的那个 MonoSpace 页面」 | 同上 |
| 揭示/兑换是宿主代码的事 | **揭示（`#25`/`#27`）与兑换（ADR-0005）都改为代理驱动**：`monospace_key_open` / `_key_redeem` 是 agent 用的工具 | ADR-0005 |
| `redeem_code` 属 L2（不可逆） | `monospace_key_redeem` 降为 **L1**（它只**登记**结果，提交动作在页面上由 agent 做） | ADR-0005 |
| 平台判定走应用侧解析 | 交给 agent（ADR-0006），应用侧只做取值收敛 | ADR-0006 |

**一处必须点明的漂移（未实现）**：本文 §1.4 / §2.1 / §4.2 的 `ask_human` 工具与 **`HumanGate` 服务**
**代码里不存在**（全仓搜 `ask_human` 只命中本文与 `docs/verify/16`）。现行 L2 门是
`src/main/agent/tool-adapter.ts` 的 `AGENT_DENIED_LAYERS = ['L2']`，而且**当前没有任何 L2 工具**
—— 兑换改为代理驱动后，应用不再需要自己拦一个不可逆提交。人在环路在本项目里的现行形态是
「agent 拿不准就停手并如实说明」（实测见 `docs/verify/34`），不是「弹框让人点确认」。

仍然**有效**的部分：权限分层的思路（§2.1）、审计留痕字段（§2.3）、上下文投喂与预算（§3）、
以及 §6 的 YAGNI 清单。

---

上游已钉死、本文只细化的决定：#9（代理是**脚本作者**不是操作者；BYOK 只留内存；零遥测；整页发不过滤）、#10（日志脱敏、凭据明文落盘的告知义务）、#11（同步/台账/判定走代码，页面操作走扩展，代理只写扩展）、#4（进程内 SDK、`noTools:"builtin"` + inline extension）、#16（MV3 子集；`nativeMessaging`/`connectNative` **不可用**；热替换成立）、#6（a11y 树为主、截图兜底、**重快照不重放**）。

> 术语：「揭示」「兑换」「登录态」「人在环路」。两个「扩展」必须区分：**Pi extension**（代理↔宿主桥，进程内）与 **browser extension**（代理的产出物，MV3）。

## 1. 工具目录

全部工具由**一个 inline Pi extension 工厂**注册（`resourceLoader: new DefaultResourceLoader({ noExtensions: true, extensionFactories: [agentToolFactory] })`），会话以 `noTools: "builtin"` 创建——**注册表里只有下面 10 个工具，没有 shell、没有文件系统工具**。

| # | 工具 | 用途 | 层级 | 留痕 |
|---|---|---|---|---|
| 1 | `snapshot_page` | 取 store 视图的裁剪 a11y 树（主输入） | L0 只读 | 是（run 制品） |
| 2 | `page_screenshot` | 截图兜底 / 给人看的证据 | L0 只读 | 是（run 制品） |
| 3 | `read_extension_source` | 读当前 browser extension 源码 | L0 只读 | 否 |
| 4 | `read_last_run` | 读上次运行报告与失败步骤 | L0 只读 | 否 |
| 5 | `list_unrevealed_keys` | 查未揭示 key | L0 只读 | 否 |
| 6 | `get_key_context` | 查某 key 的台账上下文（只读） | L0 只读 | 否 |
| 7 | `write_extension_source` | 写 / 改 browser extension 源码 | L1 写产物 | **是（强制）** |
| 8 | `validate_extension` | 校验扩展可装载性与 API 边界 | L1 写产物 | **是（强制）** |
| 9 | `activate_extension` | 激活 / 热替换扩展 | L1 写产物 | **是（强制）** |
| 10 | `ask_human` | confirm / select / input | L2 通道 | **是（决策记录）** |

### 1.1 只读观察

- `snapshot_page`　输入 `{ view: "store-fab", depth?: number = 12, maxNodes?: number = 400 }`；输出 `{ url, title, snapshot: string, refs: { [ref]: { role, name, bbox? } }, truncated: boolean }`。实现：主进程 `Accessibility.enable()` → `Accessibility.getFullAXTree` → 按 §3 规则剪枝 → 文本化。**只返回当前文档**；`truncated: true` 时提示模型改用定向查询。
- `page_screenshot`　输入 `{ view: "store-fab", fullPage?: boolean = false }`；输出 `ImageContent` + `{ url, viewport }`。**不是主路径**，仅在 §3 的四条升级条件下调用。
- `read_extension_source`　输入 `{ extensionId?: string, path?: string }`；输出该扩展 `manifest.json` + 已生成源文件列表（带内容或按 `path` 取单个）。读的是 `<userData>/generated-extensions/<extId>/`。
- `read_last_run`　输入 `{ limit?: number = 1 }`；输出最近的 run 报告：`{ runId, startedAt, endedAt, status, steps[], failedStep, errorCode }`。`errorCode` 用 #18 的 7 类枚举，未列出即 `needs_human`。

### 1.2 只读台账

- `list_unrevealed_keys`　输入 `{ limit?: number = 50, cursor?: string, platform?: "unreal"|"unity"|"gamemaker"|"any" = "any" }`；输出 `{ items: [{ keyId, title, platform, revealed: boolean, redeemed: boolean }], nextCursor }`。**不含兑换码明文**——未揭示的 key 没有码；已揭示的走 `get_key_context`。
- `get_key_context`　输入 `{ keyId: string }`；输出 `{ keyId, title, platform, revealed, redeemed, code?: string, revealOrderId, redeemAttempts[] }`。**返回兑换码明文**（`code`）。理由：代理生成「填码」脚本时，码的形态（长度、字符集、连字符位置）是脚本正确性的输入；#9 已选择「整页发不过滤」，此处不做半吊子脱敏。审计只记 `keyId`，不记明文。

### 1.3 写产物

- `write_extension_source`　输入 `{ extensionId: string, files: [{ path, content }] }`；输出 `{ version: string, diff: string, files: string[] }`。**这是代理唯一能写文件的路径**（代理没有 fs 工具），实际落盘经主进程 `artifactLedger`。`extensionId` 只能指向 `generated-extensions/` 下已存在的目录（首次生成由应用初始化）。
- `validate_extension`　输入 `{ extensionId: string }`；输出 `{ ok: boolean, diagnostics: [{ level: "error"|"warning", code, file, message }] }`。校验内容：MV3 manifest schema、**禁用 API 清单**（`cookies`/`windows`/`contextMenus`/`notifications`/`permissions`/`nativeMessaging`/`connectNative`，见 #16）、JS 语法 parse。`ok:false` 时 agent 必须修复后再激活。
- `activate_extension`　输入 `{ extensionId: string, mode: "swap"|"reload" }`；输出 `{ extensionId, version, active: true }`。`swap` = `ses.extensions.removeExtension(id)` + `ses.extensions.loadExtension(path)`；`reload` = SW `chrome.runtime.reload()`。两者 #16 均实测通过，**扩展 id 不变**。

### 1.4 人机

- `ask_human`　输入 `{ method: "confirm"|"select"|"input", title: string, message?: string, options?: string[], placeholder?: string }`；输出 `{ confirmed?: boolean, value?: string, cancelled?: boolean }`。三 mode 精确映射宿主 `ExtensionUIContext` 的 `confirm/select/input`（§4.2）。

### 1.5 明确排除

| 排除项 | 理由 | 替代 |
|---|---|---|
| `reveal_key` / `redeem_code` | **运行时不可逆写操作**。代理只在生成/修复脚本时看页面，日常执行不过模型（#9）；把不可逆操作交给模型会毁掉「预检 + 单条试探 + 有限重试」的爆炸半径控制（#7）。 | 确定性代码编排 + browser extension 执行；代理只写那个扩展。 |
| `open_store_page` | 导航是确定性编排的一部分，不需要模型每次决定；且模型选 URL 会绕开登录态探针与节流。 | 主进程 `storeSession` 编排器按状态机导航。 |
| `record_result`（写台账） | 判定与台账写入属确定性代码（#11）。代理写台账会污染唯一真源。 | 应用侧按扩展回流事件写 SQLite。 |
| shell / 文件系统工具 | `noTools:"builtin"` 全禁。代理无需也不应有进程与盘面权限。 | 唯一写路径是 `write_extension_source`。 |
| 截图之外的录屏 / screencast | 无用途，吃预算。 | 无。 |

## 2. 权限模型

三层，覆盖 §1 的全部工具。**授权判定不在各 tool 的 `execute()` 里散写**，而在两个宿主服务里集中实现。

### 2.1 三层定义

| 层 | 名称 | 覆盖工具 | 授权方式 |
|---|---|---|---|
| **L0** | 只读自动 | `snapshot_page`、`page_screenshot`、`read_extension_source`、`read_last_run`、`list_unrevealed_keys`、`get_key_context` | 自动放行；仅参数合法性检查（`extensionId`/`keyId` 存在性、`view` 白名单）。 |
| **L1** | 写产物（自动 + 强制留痕） | `write_extension_source`、`validate_extension`、`activate_extension` | 自动放行，但**必须产生审计记录**；写路径被钉死在 `generated-extensions/<extId>/`，越界即拒。 |
| **L2** | 面向人且不可逆 | `ask_human`（以及确定性代码触发的所有敏感动作） | **必须经人在环路**：`confirm` 拿到明确 `true` 才继续；`cancelled`/无响应 = 不继续。 |

### 2.2 判定实现在哪

- **L0/L1 判定** = 进程内 agent host 的 **`ToolGate`**，实现为 Pi extension 的 `pi.on("tool_call", …)` handler：读 active 工具名 + 参数，做路径白名单与存在性检查，不通过则 `block` 该 tool call（Pi 的 fail-safe 语义：handler 失败/阻断 → 工具不执行）。
- **L1 留痕** = 主进程的 **`artifactLedger`** 服务，是扩展源码落盘的**唯一写入方**。`write_extension_source` 的 `execute()` 只是向它发 IPC 请求；直接 `fs` 写在架构上不可达（无 fs 工具）。审计记录在落盘**之前**写入，落盘失败也要留痕。
- **L2 判定** = 主进程的 **`HumanGate`** 服务：`request(reason, payload) → Promise<resolution>`。代理的 `ask_human` 与确定性代码的敏感动作（揭示、兑换、账号设置）**走同一个 HumanGate**。HumanGate 负责把窗口切到接管态、等 §4.2 的完成信号、并保证「重快照不重放」。

### 2.3 审计留痕字段

每条记录一条 JSON，落在 `<userData>/audit/YYYY-MM.jsonl`：

```jsonc
{
  "id": "aud_...",              // ULID
  "ts": "2026-09-26T12:00:00Z",
  "runId": "run_...",           // 关联的代理任务
  "tool": "write_extension_source",
  "layer": "L1",                // L0 | L1 | L2
  "actor": "agent",             // agent | code
  "target": { "extensionId": "ext_fab_redeem", "keyId": null },
  "version": "1.4",             // 扩展产物版本（L0 为 null）
  "diff": "--- a/content.js\n+++ b/content.js\n...",   // L1 必填，unified diff
  "argsDigest": "sha256:...",   // 参数摘要；不落兑换码明文
  "decision": "approved",       // L2: approved | denied | aborted | timeout；L0/L1: "n/a"
  "humanRef": "ui_...",         // L2 的人机交互 id
  "result": "ok"
}
```

L0 工具**不写独立审计条目**（避免噪声），但其调用已完整落在 session JSONL（#4 的持久化会话）里；快照与截图落 run 制品目录（保留策略属未定项，见 §6）。

## 3. 上下文投喂

**不做内容脱敏，只做体量裁剪**——key 明文随页面上行是清醒选择（#9）。裁剪算法只看结构与体积，**不看内容敏感度**。

### 3.1 a11y 树剪枝（`snapshot_page`）

1. 取 `Accessibility.getFullAXTree`；丢弃 `ignored: true` 的节点。
2. **保留交互子树**：role ∈ {`button, link, textbox, searchbox, combobox, listbox, option, checkbox, radio, switch, slider, spinbutton, tab, menuitem, dialog, alertdialog, form, alert, status`}，外加其**祖先骨架**（`generic`/`group`/`list` 仅作为路径保留）。
3. 保留导航与标题骨架：`heading`、带 `name` 的 `img`、`banner`/`navigation`/`main`/`contentinfo`。
4. 丢弃装饰与噪声：无 `name` 的 `StaticText`、`InlineTextBox`、`presentation`/`none`、纯样式容器。
5. `StaticText` 的 `name` 截断到 200 字符；节点数超过 `maxNodes` 时按「交互节点优先、然后按文档序」保留，其余丢弃并置 `truncated: true`。
6. 深度超过 `depth` 的子树折叠为一行摘要（`… 12 more nodes`）。
7. 为保留节点分配 `ref: e1..eN`，同一次快照内稳定；**跨快照不保证**——人工恢复后一律重取（#6「重快照不重放」）。

### 3.2 预算

- 单次 `snapshot_page` 上限 **8k tokens**（≈400 节点）。超限即截断，不自动升级截图。
- 单次代理任务（生成/修复一个扩展）由 Pi 默认 compaction 兜底；**不设自定义 token 硬上限**（见 §6）。

### 3.3 何时升级截图 / 用 DOM 子集

- **截图**（`page_screenshot`）四条件，任一命中：① a11y 树对目标无解释力（纯 canvas 控件、谜题式人机校验）；② 需要把画面给人看（HITL 证据）；③ 连续两次 `snapshot_page` 无法定位同一目标；④ `validate_extension` 后需人工确认页面结果。截图**不随每次快照附带**。
- **DOM 子集**：仅用于 ① 取 a11y 拿不到的属性（`input.value`、`data-*`、隐藏字段）；② 验证结构性谓词（selector 命中）。实现用 `DOM.querySelector` / `webContents.executeJavaScript` 做**定向**提取。**禁止** `DOMSnapshot.captureSnapshot` 全量喂模型（Fab 首屏 2.3 MB，必爆上下文，#6 §5.1）。

## 4. 事件回流

### 4.1 单向进度（agent → UI）

- `session.subscribe(ev)`（进程内 SDK）→ 宿主经 IPC 推主进程 → `webContents.send("agent:event", ev)` → preload → React store。UI 用法：`tool_call`/`tool_result` 渲染决策日志；流式 text 渲染当前推理摘要；`message_end`/`usage` 更新预算条。
- `ctx.ui.setStatus(key, text)`：宿主实现直接映射成 `agent:status` IPC → React 底部状态槽。约定固定 key：`agent.phase`（生成 / 校验 / 激活 / 等人工）、`agent.run`（runId + 步骤序号）。单向。
- `ctx.ui.notify(message, type)` → `agent:notify` IPC → React toast（`info`/`warning`/`error`）。单向。
- `setWidget`/`setTitle`/`custom` 在 `mode:"rpc"` 下不可用或无意义（#4 §5.3、`rpc-extension-ui.md`），**不使用**。

### 4.2 `ask_human` 交互协议

会话创建后**显式**执行一次：

```ts
await session.bindExtensions({ uiContext: hostUIContext, mode: "rpc" });
// #4 事实：SDK 路径的 createAgentSession 不自行 bindExtensions；
// 不绑则 ctx.hasUI=false、ctx.ui.confirm 是 no-op。session_start/reload 后重绑。
```

`hostUIContext` 实现 `ExtensionUIContext`（`@earendil-works/pi-coding-agent`）：

| 扩展侧调用 | 宿主行为 | IPC | React |
|---|---|---|---|
| `confirm(title, message)` | 生成 `{id, method:"confirm"}` | `agent:ui.request` | 模态：确认 / 取消 |
| `select(title, options)` | 生成 `{id, method:"select", options}` | `agent:ui.request` | 模态：单选列表 |
| `input(title, placeholder)` | 生成 `{id, method:"input", placeholder}` | `agent:ui.request` | 模态：单行输入 |
| `notify(...)` | 直接转发 | `agent:notify` | toast |

回流：React resolve → `agent:ui.response { id, confirmed | value | cancelled }` → 主进程 → agent host → resolve 对应 Promise。`ask_human` 工具的 `execute()` 只是把这三个 dialog 之一包成工具调用，**没有额外语义**。

**超时策略（定死）**：`ask_human` 的三种 mode **一律不传 `timeout`**。理由：人在环路是**常态节点**（ADR-0001）；无人值守不在项目范围内。Pi 的 `timeout` 语义是「到点用默认值自动 resolve」，会静默地把「未决」变成「已决」，与 L2 的语义冲突。宿主改为**软提醒**：`HumanGate` 侧记录 `requestedAt`，超过 **5 分钟**未响应 → `notify(..., "warning")` 提醒用户窗口在等；**不自动 resolve**。L2 的终止只能来自人：`confirm=true`、`cancelled`、或应用退出。

## 5. 桥的复用结论

**能复用 Pi 的 extensions 机制作为代理 ↔ UI 的桥，并且这是推荐路径。**

- **为什么推荐**：`bindExtensions({ uiContext, mode: "rpc" })` 是唯一把 `ctx.ui.confirm/select/input` **直驱宿主实现**的官方入口（#4 §5.3 实测：绑之前 `ctx.hasUI=false`、dialog 是 no-op；绑之后 `confirm` 返回宿主的值）。进程内调用，无 JSONL 序列化，无需实现 RPC 子协议。
- **为什么不用 native messaging**：#16 §2 实测 Electron 44 的 MV3 子集里 `chrome.nativeMessaging` 不存在、`chrome.runtime.connectNative` 也不存在；SW 内也无 `ipcRenderer`/`require`（`ServiceWorkerMain.send()` 收不到）。native messaging **整条路不可用**。
- **为什么不用 RpcClient**：#4 §5.4 —— `RpcClient` 没有公开的 `extension_ui_response` 发送 API，dialog 会卡住或靠扩展侧超时 auto-resolve。
- **工具实现在哪**：inline Pi extension 工厂（跑在 agent host）注册 §1 的 10 个工具；`execute()` 通过 IPC 把请求发给**主进程**，由主进程用 `webContents.debugger`（CDP：`Accessibility.*` / `DOM.*` / `Input.*` / `Page.captureScreenshot`）驱动 store 视图，用 `ses.extensions.*` 装载/热替换扩展，用 `artifactLedger`/`HumanGate`/台账仓储提供数据。
- **两个「扩展」的分工**：Pi extension = **桥**（工具注册 + `ctx.ui`），不参与页面操作；browser extension = **产出物**，由代理生成、由确定性代码激活、由运行时执行页面操作。二者不共享代码，仅通过 §4 的事件与 §1.3 的产物交互。

## 6. 不做（YAGNI）

- **不做全自动无人值守**，不给代理任何页面操作工具（无 `click`/`type`/`navigate`）；代理永不持有执行权。
- **不做 `reveal_key`/`redeem_code`/`open_store_page`/`record_result`**（§1.5）。
- **不做 shell / 文件系统工具**（`noTools:"builtin"`）。
- **不做内容脱敏**（key 明文可上行）；**只做体量裁剪**。
- **不做** `DOMSnapshot.captureSnapshot` 全量喂模型；**不做**像素级输入当主路径。
- **不做** native messaging 桥；**不做** RpcClient 路线。
- **不做**按阶段动态切换工具集（`setActiveToolsByName` 的只读→写升级）：10 个工具全量注册，权限差异由 L0/L1/L2 判定承担。
- **不做**自定义 token 硬上限与压缩调参，用 Pi 默认 compaction。
- **不做** `ask_human` 的超时 auto-resolve（只做软提醒）；**不做**多模态以外的输入模态（语音/拖拽）。
- **不做**快照/截图/扩展产物的保留期、清理与磁盘配额（地图已列「实现期细节」）。
- **不做**工具级限流/配额（节流是编排器的职责，不是工具契约的职责）。
