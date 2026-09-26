# 把 Pi coding agent 内嵌进 Electron 应用并与外部 Pi 双向隔离（Linux 目标）

- **仓库**：`the-loki/mono-space`，issue #4（wayfinder 研究）
- **研究分支**：`research/pi-embed-isolation`（工作树 `/home/loki/Workspace/.wayfinder-wt/pi-embed-isolation`）
- **验证日期**：2026-09-26（UTC）
- **目标平台**：**仅 Linux**（x64 / arm64），Electron 桌面应用「游戏资产管家」
- **一手来源**：本机真实安装包 `/home/loki/.nvm/versions/node/v24.20.0/lib/node_modules/@earendil-works/pi-coding-agent/`，版本 **0.87.1**（`package.json`），运行环境 `linux x64 / node v24.20.0`。
  - 该已发布包**不含 `src/`**（`package.json#files` 只发布 `dist`、`docs`、`examples`），因此源码级证据使用 **编译产物 `dist/*.js` 与类型声明 `*.d.ts`**（行号可复查），文档级证据使用 `docs/*.md`。
  - Electron 侧证据使用官方文档（`electron/electron` 的 `docs/api/safe-storage.md`、`docs/tutorial/asar-archives.md`、`docs/api/utility-process.md`、`docs/api/app.md` 及 `shell/common/electron_paths.cc`；`electron-userland/electron-builder` 文档）。

**证据标签**（全文统一）：
- 【实测】= 本机 Linux 上只读/临时目录实验实际观察到的结果（命令见 §8）
- 【源码】= 从 `dist/*.js` / `*.d.ts` 读到的实现或类型
- 【文档】= 包内 `docs/*.md` 或 Electron 官方文档章节
- 【推断】= 由上述证据推导，未单独验证
- 【未验证】= 无法在本机确认，列入 §9

---

## 0. 结论先行

**推荐集成形态：进程内 SDK（`createAgentSession`）跑在 Electron 主进程或 `utilityProcess` 里；不要用 CLI 子进程，也不要用 `RpcClient`。** 理由见 §1。

**双向隔离的最小充分做法（三件套）**

1. **配置目录**：SDK 显式传 `agentDir: <app 私有目录>`（`CreateAgentSessionOptions.agentDir`）。显式 `agentDir` **优先于** `PI_CODING_AGENT_DIR` 环境变量【源码】【实测】。若走 CLI/RPC，则必须显式设置 `PI_CODING_AGENT_DIR`——因为配置目录**没有** CLI 覆盖开关，只有 env。
2. **会话目录**：SDK 传 `sessionManager: SessionManager.inMemory()`（临时）或显式持久化目录；注意 **SDK 不读 `PI_CODING_AGENT_SESSION_DIR`**【源码】【实测】。CLI/RPC 下该目录优先级为 `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `settings.json#sessionDir`【源码】【实测】。
3. **环境清洗**：启动时显式设置应用自己的 `PI_*` 并清掉外部 Pi 可能注入的变量与 provider key 环境变量（清单见 §2.6、§7）。外部 Pi 实际只向子进程注入 `AI_AGENT=pi`、`PI_CODING_AGENT=true` 以及（仅 shell 工具内）`PI_SESSION_ID/PI_SESSION_FILE/PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL`；这些变量 **Pi 自己不读**，只写【文档】【源码】【实测】。

**依赖形态**：把 `@earendil-works/pi-coding-agent@0.87.1` 作为应用依赖**锁版本打包**，**不**依赖用户全局 `pi`，**不**读 `~/.pi/agent`。Linux 打包需 `asarUnpack` 原生模块与子进程入口（§3）。

**模型与凭据**：SDK 用 `modelRuntime.setRuntimeApiKey()` 做 BYOK（不落盘）；自定义/本地端点写 app 私有 `models.json`；Ollama 走 `models.json` 的 OpenAI 兼容端点（§4）。

**工具与 UI 桥**：`noTools: "builtin"` + inline extension 注册应用自定义工具，可只暴露浏览器动作；用 `session.bindExtensions({ uiContext, mode: "rpc" })` 把扩展的 `confirm/notify` 直接接到 React 对话框——**已实测可行**（§5）。

**凭据保管（Linux 特有风险）**：Electron `safeStorage` 在 Linux 依赖 libsecret/KWallet，无桌面密钥环时回退 `basic_text`（硬编码口令，"unprotected"）。应用应检测 `getSelectedStorageBackend()`，优先「内存里用 `setRuntimeApiKey`」或 `models.json` 的 `!command`（`secret-tool`/`kwallet-query`），不要把明文 key 落到 pi 的 `auth.json`（pi 自身不加密，仅 `0600`）（§4.5）。

---

## 1. 集成形态取舍：进程内 SDK vs RPC 子进程 vs JSON/print

### 1.1 候选形态与事实

| 形态 | 进程模型 | 流式事件 | 生命周期 | 崩溃隔离 | 打包（Linux） | 适合 |
|---|---|---|---|---|---|---|
| **SDK `createAgentSession`** | 与应用同进程（主进程或 `utilityProcess`） | `session.subscribe()` 直接回调，零序列化 | 与 app 同生命周期，`session.dispose()` 显式释放 | 无（同进程崩溃=app 崩溃） | 纯 JS + 少量 `.node`/`.wasm`，无「node on PATH」问题 | **长期会话 + 自定义工具 + 自绘 UI（本用例）** |
| **RPC 子进程** | 独立 Pi 进程，JSONL 双向 | 事件经 stdout JSONL | 长驻，stdin 关闭即有序退出 | 有（子进程崩溃可重启） | 需要额外 Node 运行时；asar 内入口不可被 `spawn` 执行（§3.3） | 需要强隔离/独立升级 |
| **JSON（`--mode json`）** | 一次性子进程 | JSONL 事件流，只到本次运行结束 | 启动即跑完即退，不接受后续命令 | 有 | 同 RPC | 单次结构化任务 |
| **Print（`--print` / `--mode text`）** | 一次性子进程 | 只有最终文本 | 同上 | 有 | 同 RPC | 一次性、只要最终答案 |
| **Interactive（TUI）** | 交互终端 | — | — | — | 不适用桌面内嵌 | 人工直接用 |

（模式名称与语义见 `docs/cli-integration.md`「Choose a mode」；CLI 实际参数名为 `--mode text|json|rpc` 与 `--print/-p`，见 `dist/cli/args.js` 第 40–54、134 行与 `--help`【源码】。`--help` 是安装版本的权威。）

### 1.2 为什么推荐进程内 SDK

针对「应用内长期驱动浏览器自动化、商店页面流程差异极大、需要弹确认框/上报进度」这个用例：

1. **事件与工具调用零跨进程成本**：`session.subscribe()` 直接拿到 `message_update`/`tool_execution_*`/`agent_settled` 等事件【文档 `docs/sdk.md`「Subscribing to events」】；自定义工具 `execute()` 就是应用自己的函数，可直接调用 Playwright/CDP。
2. **扩展 UI 能直达 React**：扩展 `ctx.ui.confirm/notify` 可以通过宿主自实现的 `ExtensionUIContext` 直接驱动应用对话框。**这是 SDK 相比 RPC 的决定性优势**——`RpcClient` 没有回传 `extension_ui_response` 的公开 API（§5.4）。**已实测**：`session.bindExtensions({ uiContext, mode: "rpc" })` 后，`ctx.ui.confirm()` 调用到了宿主实现并返回 `true`（§8 实验 6）。
3. **不依赖系统 Node**：RPC 方案下 `RpcClient` 会 `spawn("node", ...)`，要求 PATH 里有 `node`；Linux 上打包的 Electron 应用（AppImage/deb）不保证有【源码 `dist/modes/rpc/rpc-client.js:42`】。进程内 SDK 无此问题。
4. **凭据可以不落盘**：`modelRuntime.setRuntimeApiKey(provider, key)` 只在进程内生效【文档 `examples/sdk/09-api-keys-and-oauth.ts`】【源码】。
5. **会话可纯内存**：`SessionManager.inMemory()`【文档 `docs/sdk.md#sessionmanager-api`】。

代价：崩溃不隔离、agent 与 UI 共享进程。若需要崩溃隔离，**建议的折中是**：把 SDK 放进 Electron 的 `utilityProcess.fork()`（Chromium Services 提供的 Node 子进程，支持 `env`/`cwd`/MessagePort，`ready` 之后可调用【文档 Electron `utility-process.md`】），在主进程里仍用 SDK 的 TypeScript API（在 utility 内 `createAgentSession`），只把事件/UI 通过 MessagePort 中转到 React。这样既保留「直接 TS API + 自供 `ExtensionUIContext`」，又拿到进程隔离。

### 1.3 何时才用 RPC

- 你确实需要 Pi 与 app 用不同 Node 版本、或希望 Pi 可独立升级/重启：用 RPC，但**不要用 `RpcClient`**，而是像官方 `examples/rpc-extension-ui.ts` 那样**自己 `spawn` 并手写 JSONL 解析**，这样才能处理 `extension_ui_request` 并回传 `extension_ui_response`（`docs/rpc-extension-ui.md`）。
- 启动方式建议：`ELECTRON_RUN_AS_NODE=1` + `process.execPath` 作为「node」，并传入**白名单 env**（`spawn` 的 `env` 选项），入口用 `process.resourcesPath` 下 `app.asar.unpacked` 里的 RPC bundle（§3.3）。

### 1.4 不建议

- **依赖用户全局 `pi`**：会引入版本漂移、并让它有机会读外部配置（若用户 shell 有 `PI_CODING_AGENT_DIR`）。
- **`RpcClient` 做交互式 UI**：见 §5.4 的缺口。

---

## 2. 隔离面逐项确认

### 2.1 `PI_CODING_AGENT_DIR`（配置目录）

**事实**
- 名称常量：`ENV_AGENT_DIR = \`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR\``，其中 `APP_NAME = pkg.piConfig?.name || "pi"`【源码 `dist/config.js` 约 400–407 行】。默认名因此是 `PI_CODING_AGENT_DIR`。
- 读取点：`getAgentDir()` 先读 `process.env[ENV_AGENT_DIR]`，否则 `join(homedir(), CONFIG_DIR_NAME, "agent")`（`CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".pi"`）【源码 `dist/config.js:421-426`】。
- 该目录承载：`settings.json`、`models.json`、`auth.json`、`extensions/`、`skills/`、`prompts/`、`themes/`、`sessions/`、`trust.json`、`npm/`（安装的 pi 包）【文档 `docs/configuration.md`「Agent directory」】【实测：`pi list` 读的就是它】。
- **SDK 优先用显式 `agentDir`**：`const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();`，且 `authPath/modelsPath` 也据此派生【源码 `dist/core/sdk.js:69-72`】。**注意**：不传 `agentDir` 时 SDK 仍会读 `PI_CODING_AGENT_DIR`【实测 §8 实验 7】。
- **CLI/RPC 没有配置目录的 CLI 覆盖项**（`--help` 里只有 env 说明，见 `dist/cli/args.js:432`），只能靠 env 或 SDK 选项【源码】【实测】。

**结论**：SDK 场景**永远显式传 `agentDir`**，把「读哪个配置目录」变成代码里的事实，而不是环境变量里的事实。

### 2.2 派生环境变量名规则，以及 fork 改名能否用于命名空间隔离

**规则（已实测）**：`<piConfig.name.toUpperCase()>_CODING_AGENT_DIR` 与 `_CODING_AGENT_SESSION_DIR`；`piConfig.configDir` 同时决定默认路径 `~/<configDir>/agent`。

**实测证据**：构造一个只含 `package.json` 的假包目录，令 `piConfig.name = "game-asset-butler"`、`configDir = ".game-asset-butler"`，用 `PI_PACKAGE_DIR` 指过去后运行本机 `pi --help`：

```
PI_CODING_AGENT_DIR              - Config directory (default: ~/.pi/agent)           # 基线
GAME-ASSET-BUTLER_CODING_AGENT_DIR - Config directory (default: ~/.game-asset-butler/agent)   # 改名后
```

【实测 §8 实验 1】。注意 **只做 `toUpperCase()`、不做清洗**：连字符保留，得到 `GAME-ASSET-BUTLER_...` 这种在 shell 里无法直接 `export` 的变量名（`${...}` 展开会当成减法/命令分隔）；POSIX 环境变量名允许这种字符（`env 'A-B=1' node -e ...` 可设置），但很难用【源码 `dist/config.js:406-407`】【推断：shell 可移植性差】。

**能否用作命名空间隔离？** 可以，但有前提：
- 需要让 `APP_NAME` 变成你的名字，而 `APP_NAME` 来自**包自身的 `package.json#piConfig.name`**，读取路径由 `getPackageDir()` 决定；`getPackageDir()` 允许 `PI_PACKAGE_DIR` 覆盖，否则从 `dist/` 向上找 `package.json`【源码 `dist/config.js`】。
- 因此可行路径只有两条：(a) **fork/私有发布**一个改过 `package.json#piConfig` 的包并设为依赖；(b) 打包时**补丁依赖里的 `package.json`**（不推荐，脆）。
- 收益：应用只认 `GAME-ASSET-BUTLER_CODING_AGENT_DIR`，从而**忽略**外部环境里万一存在的 `PI_CODING_AGENT_DIR`——这是纵深防御。
- **但这是次要手段**：显式 `agentDir`/显式 env 才是主手段。若只为隔离，没必要为此 fork。**建议**：把 fork 改名列为「可选加固」，不列为必需。

### 2.3 `PI_CODING_AGENT_SESSION_DIR`、`--session-dir`、`--no-session`

**优先级（源码 + 实测）**：`main.js` 中

```js
const envSessionDir = process.env[ENV_SESSION_DIR];
const sessionDir = (parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
    (envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
    startupSettingsManager.getSessionDir();
```

`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `settings.json#sessionDir`【源码 `dist/main.js:536-539`】【文档 `docs/sessions.md`「Control session storage」】。

**实测**（RPC `get_state` 返回 `sessionFile`）：
- 只设 `PI_CODING_AGENT_SESSION_DIR=$EXP/s1` → `sessionFile` 在 `s1/`。
- 同时设 env 与 `--session-dir $EXP/s2` → 在 `s2/`（CLI 胜）。
- 都不设 → `$EXP/a1/sessions/--home-loki-Workspace-mono-space--/…`（由 agentDir 派生）。
- `--no-session` → `sessionFile: null`（临时会话）。

【实测 §8 实验 3】

**重要差异**：**SDK 完全不读 `PI_CODING_AGENT_SESSION_DIR`**。实测：设了 `PI_CODING_AGENT_DIR=envagent` 与 `PI_CODING_AGENT_SESSION_DIR=envsess`，SDK 的 `sessionFile` 落在 `envagent/sessions/--tmp--/…`，`envsess` 目录被创建但为空【实测 §8 实验 7】。SDK 想控制会话位置只有 `sessionManager` 选项【源码 `dist/core/sdk.js:75`】。

### 2.4 外部 Pi 到底会注入什么，哪些会被读

**会被注入到子进程（外部 Pi 启动的进程会继承）**：
- `AI_AGENT=pi`、`PI_CODING_AGENT=true`：进程标记，CLI/RPC 入口设置，子进程继承，**SDK 嵌入时不自动设置**【源码 `dist/cli/setup.js:5-6`、`dist/rpc-entry.js:4-5`】【文档 `docs/environment-variables.md`「Process Marker」】。
- shell 工具（`bash`/`powershell`）执行时注入：`PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`【文档 `docs/environment-variables.md`「Shell Tool Session Environment」】。

**这些变量 Pi 自己读吗？** 不读。全仓 grep 只找到「写」的位置（setup/rpc-entry/bash 工具），**没有** `process.env.PI_MODEL` / `PI_PROVIDER` / `PI_SESSION_ID` 的读取点【源码 grep】【实测 §8 实验 3E：故意传入这些陈旧变量，内嵌 agent 依然用 `models.json` 里的 ollama 模型、thinking=off】。

**真正会被读、且能被外部环境污染的输入**：
- `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`（配置/会话目录）。
- `PI_PACKAGE_DIR`（包目录，影响资源路径）、`PI_OFFLINE`、`PI_SKIP_VERSION_CHECK`、`PI_TELEMETRY`、`PI_CACHE_RETENTION`、`PI_SHARE_VIEWER_URL`、`PI_RADIUS_GATEWAY`、`HTTP_PROXY`/`HTTPS_PROXY`、`VISUAL`/`EDITOR`【文档 `docs/environment-variables.md`「Pi Process Configuration」】。
- **provider API key 环境变量**（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`……）——被 pi-ai 的环境发现逻辑读取【源码 `node_modules/@earendil-works/pi-ai/dist/env-api-keys.js#getApiKeyEnvVars`】。这是「外部 Pi shell 导出过 key」时最现实的污染面。
- 还有 TUI 相关检测变量（`PI_HYPERLINKS`、`PI_IMAGE_PROTOCOL`、`PI_TRUE_COLOR`、`PI_HARDWARE_CURSOR`、`PI_TUI_ESC_TIMEOUT`）——非 TUI 内嵌基本无关【推断】。

### 2.5 显式覆盖能否压过 env？

- **配置目录**：SDK 用 `agentDir` 选项可压过 `PI_CODING_AGENT_DIR`【源码】【实测 §8 实验 5：env 指向不存在的目录，显式 `agentDir` 仍正确解析模型】。CLI/RPC **无 CLI 覆盖**，只能改 env。
- **会话目录**：`--session-dir` 压过 `PI_CODING_AGENT_SESSION_DIR`【实测】。
- **模型/凭据**：`--api-key`（CLI）与 `setRuntimeApiKey`（SDK）在解析链最前，压过 `auth.json`、`models.json#apiKey`、env【源码 `pi-ai/dist/auth/resolve.js#resolveProviderAuthWithSignal`】【文档 `docs/models.md`「Authenticate」】。
- **工具**：`--tools/--exclude-tools/--no-tools`（CLI）与 `tools/excludeTools/noTools`（SDK）压过 `settings.json#defaultTools`【源码 `dist/core/sdk.js:142-145`】【文档 `docs/settings.md`「Tools」】。

### 2.6 建议的环境处理（Linux）

**应用启动时显式设置**（防止外部 Pi 残留）：
`PI_CODING_AGENT_DIR=<app 私有 agent 目录>`（SDK 亦可用 `agentDir` 选项代替）、`PI_CODING_AGENT_SESSION_DIR=<app 私有会话目录>`（仅 CLI/RPC 需要）、`PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`、`HTTP_PROXY/HTTPS_PROXY`（由应用决定）。

**启动时删除/忽略**：`AI_AGENT`、`PI_CODING_AGENT`、`PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`、`PI_HARDWARE_CURSOR`、`PI_HYPERLINKS`、`PI_IMAGE_PROTOCOL`、`PI_TRUE_COLOR`、`PI_TUI_ESC_TIMEOUT`、`VISUAL`、`EDITOR`、`PI_PACKAGE_DIR`（除非自己做 fork 改名）。

**provider key**：按产品决策（§4.3）。若要「完全不吃用户已有 key」，把这些变量从进程环境里删掉，或改用子进程 + 白名单 env。

> 删除方式：进程内 SDK 只能改 `process.env`（会影响整 app），因此**更强的做法是把 agent 放进 `utilityProcess`/子进程并传白名单 `env`**。Node 语义：`spawn(..., { env: { ...process.env, FOO: undefined } })` 会**真正省略** `FOO`（实测 `Object.prototype.hasOwnProperty.call(process.env,'FOO') === false`）——这正好配合 `RpcClient` 的 `env: { ...process.env, ...options.env }` 合并方式【源码 `dist/modes/rpc/rpc-client.js:44`】【实测 §8 实验 4】。

---

## 3. 依赖形态与 Linux 打包

### 3.1 锁版本依赖 vs 用户全局 `pi`

- 用户全局 `pi` 的路径与版本不可控，且用户可能给 `pi` 设过 `PI_CODING_AGENT_DIR` 等变量；依赖它等于把隔离交给用户。
- 官方 `containerization.md` 也明确「不要把宿主 `~/.pi/agent` 挂进容器，除非你就是要共享配置」——同样的思路适用：**应用自带一份、指向自己的目录**。
- **结论**：把 `@earendil-works/pi-coding-agent` 作为应用 dependency **精确锁版本**（`"0.87.1"`，不要 `^`），因为它内部行为（env 名、优先级、协议）是版本相关的。

### 3.2 包结构事实（与打包相关）

- `"type": "module"`（ESM）、`"engines": { "node": ">=22.19.0" }`、`main: ./dist/index.js`、`bin: { pi: dist/bundle/cli.js }`、`exports["./rpc-entry"] = dist/bundle/rpc-entry.js`【源码 `package.json`】。
- `dist/bundle/` 是自包含产物：`rpc-entry.js` 只 `import` 同目录 `chunks/*.js`，chunks 只依赖 Node 内置模块（grep 未发现任何 `node_modules` 外部 import）【源码】。体积约 **8.4 MB**。
- `dist/bundle/cli.js` 只有几行：`enableCompileCache()` + `createRequire(import.meta.url)("./cli-runtime.js")`——用 `require()` 加载 ESM，依赖 Node 的 require(ESM) 支持（Node ≥22.12）【源码】。**这也意味着 `bin` 入口对 Node 版本有隐性要求**。
- 原生/二进制资产：
  - `node_modules/@earendil-works/pi-tui/native/linux/prebuilds/linux-{x64,arm64}/linux-platform-x11.node`（**Linux 只有 x11 变体**）【源码/文件系统】。加载是**惰性**的：`getNativePlatformHelper()` 在 Linux 直接返回 `undefined`，只有 `getNativeClipboard()` 且 `process.env.DISPLAY` 存在时才尝试加载 `linux-platform-x11.node`【源码 `pi-tui/dist/native-platform.js`】。非 TUI 内嵌基本不会触发。
  - `node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm`（~1.8 MB，图像处理，wasm 非 .node）【文件系统】。`build` 脚本把 wasm 复制到 `dist/`【源码 `package.json#scripts.copy-binary-assets`】。
  - 依赖树里还有 `@esbuild/*/esbuild.wasm`（jiti/esbuild，用于加载 TS 扩展）【文件系统】。
- **`dist/index.js` 静态 re-export 了 interactive/TUI 组件**（`export { InteractiveMode, ... } from "./modes/index.ts"`）【源码 `dist/index.js`】，因此 `import "@earendil-works/pi-coding-agent"` 会加载 `pi-tui` 模块代码（`.node` 仍惰性）。用 esbuild/vite 打包主进程时注意别把 TUI 依赖摇不掉而体积膨胀【推断】。

### 3.3 asar、子进程入口、原生模块（Linux）

**事实（Electron 官方文档）**
- **asar 里不能直接执行二进制**：`child_process.exec` 与 `child_process.spawn` **不支持**执行 asar 内文件；只有 `execFile` 支持，且官方建议把「外部可执行文件」**解包**到 `app.asar.unpacked`，运行时用 `process.resourcesPath` 引用（避免 `EACCES`/`EBADF` 与杀软解包告警）——`docs/tutorial/asar-archives.md`「Limitations of the Node API > Executing Binaries Inside ASAR archive」。
- 原生 `.node` 用 `--unpack *.node` 解包，生成 `app.asar.unpacked/`，**必须与 `app.asar` 一起分发**（同页「Adding Unpacked Files to ASAR archives」）。electron-builder 对应配置：`asar: { unpack: ["**/*.node"] }`。
- `process.noAsar = true` 可整体关闭 asar 支持（`docs/api/process.md`）。

**对 Pi 内嵌的映射**
- **子进程方案（RPC）**：入口 `dist/bundle/rpc-entry.js` 与它依赖的 `chunks/*` 必须位于 **`app.asar.unpacked`**（或 `extraResources`），并且要用 `execFile` 语义/绝对真实路径启动。若坚持 `spawn`，参数里的路径要指向 `app.asar.unpacked`**真实路径**，而不是 `app.asar` 内路径【文档】【推断】。
- **进程内 SDK 方案**：主进程用 Electron 打补丁的 `fs` 从 asar 读 JS 没问题；但 `pi-tui` 的 `.node` 是 `createRequire()` 动态加载，**在 asar 内会失败**（Electron 对 `.node` 的 asar 处理会解包到临时目录，但官方推荐显式解包）→ 稳妥做法仍是 `asarUnpack` 整个 `**/*.node`，并把 wasm 一并考虑（wasm 走 `fs` 读，通常 asar 内可读；`photon` 的 wasm 由 `copy-assets` 放在 `dist/`，`asarUnpack` wasm 更保险）【文档】【推断】。
- **`getNativeModuleCandidates()`** 会在 `require.resolve("@earendil-works/pi-tui")` 得到的包目录、模块自身目录、以及 **`dirname(process.execPath)`** 下寻找 `native/<platform>/prebuilds/...`【源码 `pi-tui/dist/native-module-path.js`】。打包后若依赖被解包到 `app.asar.unpacked/node_modules/...`，`require.resolve` 会解析到 `.unpacked` 真实路径，`.node` 能正常加载【推断，建议做一次目标发行版冒烟测试】。

### 3.4 ESM / CJS / Node 版本

- 包是 ESM；Electron 主进程若用 ESM（`type: module` 或 `.mjs`），`import` 直接可用；若主进程是 CJS，需要 `await import()`（Electron 支持 ESM 主进程，且较新版本才稳定，**具体最低 Electron 版本未验证 → §9**）【文档/推断】。
- **Node 版本约束 `>=22.19.0`**：进程内 SDK 使用的是 **Electron 内置 Node**，不是系统 Node。必须选一个内置 Node ≥22.19 的 Electron 版本（Electron 主版本与 Node 版本对应关系需查目标版本 release notes，**未验证 → §9**）。`dist/bundle/cli.js` 的 `require(ESM)` 也要求 Node ≥22.12。
- RPC 子进程若用 `ELECTRON_RUN_AS_NODE=1` + `process.execPath`，跑的同样是 Electron 内置 Node，约束一致；若用系统 `node`，由用户环境决定（不推荐）。

### 3.5 x64 / arm64（Linux）

- 需要为 `linux-x64` 与 `linux-arm64` 分别出包；`pi-tui` 两个架构都有 prebuild（`linux-x64`、`linux-arm64`），无需自编译【文件系统】。
- 交叉构建 arm64 可用 electron-builder 文档给出的 Docker/QEMU 流程：`docker run --privileged --rm tonistiigi/binfmt --install arm64,arm`，再 `electron-builder --linux --arm64`；electron-builder v27 起 `arch: "all"` 在 Linux 展开为 **x64 + arm64**（不再含 ia32/armv7l）【文档 `electron-builder` architecture / v27-breaking-changes】。
- AppImage/deb 本身与架构绑定，需分架构产出【文档/推断】。

### 3.6 打包落地建议

1. `dependencies` 精确锁 `@earendil-works/pi-coding-agent@0.87.1`（及其传递依赖用 lockfile 锁定）。
2. electron-builder：
   - `asarUnpack`: `**/*.node`（覆盖 `pi-tui` 的 Linux prebuild）与需要执行/读取的 wasm；若走 RPC 子进程，额外解包 `@earendil-works/pi-coding-agent/dist/bundle/**`。
   - 目标：`linux: [AppImage, deb]`，`arch: [x64, arm64]`。
3. 进程内 SDK：把 agent 放主进程（简单）或 `utilityProcess`（隔离，推荐用于浏览器自动化这种长任务）。
4. 首次启动在 app 私有目录初始化：`<userData>/pi-agent/{models.json,settings.json}` + 空 `sessions/`、`auth.json`（或用内存凭据则不建）。

---

## 4. 模型与凭据

### 4.1 凭据解析优先级（代码证据）

`resolveProviderAuthWithSignal()` 的顺序【源码 `node_modules/@earendil-works/pi-ai/dist/auth/resolve.js`】：

1. `overrides.apiKey`（来自 CLI `--api-key` 或 SDK `setRuntimeApiKey`/`ModelRuntimeAuthOverrides.apiKey`）——**最高**。
2. 已存凭据 `auth.json`（`oauth` 或 `api_key`）；注释明确：「A stored credential owns the provider: ambient/env is consulted only when nothing is stored」。
3. 否则进入 ambient：`provider.auth.apiKey.resolve()`。在组合 provider 里 `resolve` 的顺序是：credential → **`models.json`/extension 的 `rawKey`** → 继承的（env）实现【源码 `dist/core/provider-composer.js:211-275`】。

与 `docs/models.md`「Authenticate」的表述一致：**运行时 `--api-key` → `auth.json` → `models.json#apiKey` → provider 环境变量/云环境凭据**。

补充源码点：`--api-key` 的处理在 `dist/main.js:647-655`（`await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey)`）；`ModelRuntime.getProviderAuthStatus()` 返回 `runtime`/`stored`/`environment`/`models_json_key` 等来源【源码 `dist/core/model-runtime.js:411-421`】。

**关键限制**：`CreateModelRuntimeOptions` **没有**注入自定义 env/authContext 的选项【源码 `dist/core/model-runtime.d.ts`】，`AgentSession` 内部调用 `modelRuntime.getAuth(model, { signal })` 也不带 `env` 覆盖【源码 `dist/core/agent-session.js:188,219`】。所以**进程内 SDK 的 ambient 解析一定会看 `process.env`**；要彻底屏蔽继承的 provider key，必须改 `process.env` 或改用子进程白名单 env（§2.6）。

### 4.2 provider 与对应环境变量（`docs/providers.md` + 源码对照）

`docs/providers.md`「Use an API key from the environment」列出主表；源码 `pi-ai/dist/env-api-keys.js#getApiKeyEnvVars` 的映射与之对应（摘要，完整列表见两处原文）：

| provider | 环境变量 |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY`（另识别 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_OAUTH_TOKEN`） |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| Google Vertex | `GOOGLE_CLOUD_API_KEY` / ADC（`GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`） |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Mistral / Groq / xAI / Cerebras | `MISTRAL_API_KEY` / `GROQ_API_KEY` / `XAI_API_KEY` / `CEREBRAS_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI | `ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY` |
| Radius | `RADIUS_API_KEY` |
| Hugging Face / Fireworks / Together / Baseten | `HF_TOKEN` / `FIREWORKS_API_KEY` / `TOGETHER_API_KEY` / `BASETEN_API_KEY` |
| Amazon Bedrock | `AWS_PROFILE` 或 IAM/`AWS_BEARER_TOKEN_BEDROCK`（`AWS_REGION`/`AWS_DEFAULT_REGION`） |
| Cloudflare（Gateway / Workers AI） | `CLOUDFLARE_API_KEY`（+ `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_GATEWAY_ID`） |
| 其他（NVIDIA/MiniMax/Moonshot/Kimi/Meta/OpenCode/Qwen/Xiaomi/…） | 见 `docs/providers.md` 表 |

【文档 `docs/providers.md`】【源码 `env-api-keys.js`】

### 4.3 BYOK（用户自带 key）怎么接

推荐优先级：
1. **应用设置界面输入 → 内存态**：`ModelRuntime.setRuntimeApiKey(provider, key)`（SDK）或 CLI `--api-key`（仅 RPC/CLI），**不写任何文件**【文档 `examples/sdk/09-api-keys-and-oauth.ts`】【源码】。配合 §4.5 的 safeStorage 做「加密存盘、启动解密后注入内存」。
2. **`models.json` 的 `apiKey`**：写 app 私有 `models.json`，支持字面量、`$ENV`/`${ENV}` 插值、`!command`【文档 `docs/models.md`「Configure a compatible endpoint」】。
3. **`auth.json`**：`key` 支持 `!command`（如 `!security find-generic-password…`；Linux 换成 `secret-tool`）【文档 `docs/providers.md`「Load an API key from a command」】。注意 **pi 的 `auth.json` 是明文 JSON，仅设 `0600`**，不做加密【源码 `dist/core/auth-storage.js:15,30,66,140` 只用 `writeFileSync(..., { mode: 0o600 })` 与 `JSON.stringify`】【实测：本机 `~/.pi/agent/auth.json` 权限 600】。
4. 环境变量：最不推荐（易被外部污染）。

**`!command` 的安全语义（Linux）**：`resolve-config-value.js` 识别首个 `!` 为 shell 命令，非 Windows 走 `execSync(command)`（默认 `/bin/sh -c`），10s 超时，stdout trim 后作为值【源码 `dist/core/resolve-config-value.js#executeWithDefaultShell`】。`auth.json` 的 key 命令结果**在进程内缓存**；`models.json` 的 header/key「run at request time and are not cached」（`models.md`），源码对应 `resolveConfigValueUncached`。这意味着：**能执行 shell**，所以 `models.json`/`auth.json` 必须由应用自己写、不可来自不可信来源（与 `docs/security.md` 的告警一致）。

### 4.4 本机 Ollama / llama.cpp

- **Ollama / LM Studio / vLLM / SGLang**：走 `models.json` 的兼容端点，`api: "openai-completions"`，`apiKey` 可写 dummy（Ollama 忽略）【文档 `docs/models.md`「Configure a compatible endpoint」】：
  ```json
  { "providers": { "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions",
    "apiKey": "ollama", "models": [ { "id": "qwen2.5-coder:7b" } ] } } }
  ```
- **llama.cpp router**：Pi 直接集成，`/llama` 管理、`/model` 选择【文档 `docs/models.md`「Connect local models」、`docs/llama-cpp.md`】。
- 这两者都**不需要** provider key 环境变量；把 app 私有 `models.json` 写好后，`get_available_models`/`/model` 即可见（实测：自定义 `models.json` 在私有 agentDir 下能离线解析出 ollama 模型【实测 §8 实验 3】）。
- **Ollama 常见坑**：只有能解析出凭据的 provider 才会在 `/model` 出现；dummy `apiKey` 正是为此【文档 `docs/models.md`「A model does not appear」】。

### 4.5 Linux 上的密钥保管（XDG + safeStorage）

**路径（Electron / Linux）**
- `app.getPath('userData')` = `$XDG_CONFIG_HOME`（默认 `~/.config`）+ 应用名，即 **`~/.config/<appName>`**（源码 `shell/common/electron_paths.cc`：Linux `DIR_APP_DATA = $XDG_CONFIG_HOME or ~/.config`，`userData = appData/<appName>`）【文档 Electron】。
- 官方建议把应用文件放在 `userData` 的**子目录**，避免与 Chromium 的 `Cache`/`GPUCache`/`Local Storage` 冲突【文档 Electron `app.md`】。
- `~/.local/share`（XDG_DATA_HOME）**不是** `app.getPath` 直接暴露的路径；若会话/缓存体积大想放那里，需自行读 `XDG_DATA_HOME` 并回退 `~/.local/share`【文档/推断】。
- **Pi 私有目录建议**：`<userData>/pi-agent`（对应 Linux `~/.config/<appName>/pi-agent`）传给 `agentDir`；会话若很大可另指 `<XDG_DATA_HOME>/<appName>/pi-sessions` 并传 `sessionManager`/`--session-dir`。

**`safeStorage` 在 Linux 的实际行为（Electron 官方文档）**
- 后端由桌面环境或 `--password-store` 决定，`safeStorage.getSelectedStorageBackend()` 返回：
  `basic_text`（环境不可识别或 `--password-store="basic"`）、`gnome_libsecret`、`kwallet`/`kwallet5`/`kwallet6`、`unknown`（`ready` 之前）【文档 `docs/api/safe-storage.md`】。
- 官方原文：「Note that not all Linux setups have an available secret store. If no secret store is available, items stored using the `safeStorage` API will be unprotected as they are encrypted via **hardcoded plaintext password**. You can detect when this happens when `getSelectedStorageBackend()` returns `basic_text`.」
- `safeStorage.setUsePlainTextEncryption(true)`：在**没有可用** OS 口令管理器时，强制用「内存口令」生成对称密钥（Windows/macOS 上是 no-op）【文档】。
- 需要 `app` 已 `ready`：`encryptStringAsync()` 会显式检查 `is_ready()`，未 ready 直接 reject（源码 `shell/browser/api/electron_api_safe_storage.cc`）【文档】。
- **即将弃用**：`isEncryptionAvailable()`/`encryptString()`/`decryptString()` 在 **Electron 46 之前**被弃用，改为 `isAsyncEncryptionAvailable()` / `encryptStringAsync()` / `decryptStringAsync()`【文档 `docs/breaking-changes.md`】。

**给「游戏资产管家」的凭据方案**
1. 不要依赖 `safeStorage.isEncryptionAvailable()` 单独判断安全性；**以 `getSelectedStorageBackend()` 为准**：若为 `basic_text`，在 UI 明确告知「本机无桌面密钥环，key 仅以弱保护存储」。
2. 首选：用 safeStorage（新代码用 async API）加密后存 app 私有文件，**启动时解密并 `setRuntimeApiKey()` 注入内存**，不落 pi 的 `auth.json`。
3. 次选：`models.json#apiKey` 写 `!secret-tool lookup service game-asset-butler provider anthropic`（GNOME Keyring）或 `!kwallet-query ...`（KWallet）——让密钥留在系统密钥环，pi 按需取用。
4. 无论哪种，**不要**把 key 写进 `auth.json` 明文（pi 不加密，仅 `0600`），除非接受明文落盘。

---

## 5. 工具集与权限

### 5.1 SDK 裁剪工具（实测矩阵）

`createAgentSession` 的 `tools`（allowlist）/`excludeTools`（denylist）/`noTools`（`"all"`|`"builtin"`）/`customTools` 逻辑见 `dist/core/sdk.js:142-145`。

实测（一个 inline extension 注册了 `app_browser_action`）：

| 选项 | 生效工具 |
|---|---|
| 默认（无选项） | `read, bash, edit, write, app_browser_action` |
| `noTools: "builtin"` | **`app_browser_action`**（只保留扩展/自定义工具）✅ |
| `noTools: "all"` | `[]` |
| `tools: []` | `[]` |
| `tools: ["read"]` | `["read"]` |
| `tools: ["app_browser_action"]` | `["app_browser_action"]` |

【实测 §8 实验 5】

**结论**：要「只暴露应用自定义的浏览器工具、禁用 shell/文件工具」→ **`noTools: "builtin"` + inline extension 注册自定义工具**（不要用 `tools: []`，那会把自定义工具也清掉）。

**运行时也支持动态切换**：`session.setActiveToolsByName(names)`（会话控制）、扩展里 `pi.setActiveTools()`【文档 `docs/extensions.md`「Activate tools dynamically」】【源码 `dist/core/agent-session.d.ts:349`】。这适合「只读阶段→下单阶段」临时升级工具集【推断】。

### 5.2 CLI / RPC 的开关

- `--no-tools, -nt`：禁用全部工具（内建 + 扩展）。
- `--tools, -t <a,b>`：allowlist。
- `--exclude-tools, -xt <a,b>`：denylist。
- `--no-extensions, -ne`：禁用扩展**发现**（显式 `-e` 仍生效）。
- `--no-skills/-ns`、`--no-prompt-templates/-np`、`--no-themes`、`--no-context-files/-nc`（禁用 `AGENTS.md`/`CLAUDE.md` 发现）。
- `--approve/-a` / `--no-approve/-na`：项目信任的一次性决定。

【源码 `dist/cli/args.js:104-116,145,149,174-183,215-218` 与 `--help` 文本 304–318】【文档 `docs/security.md`「Project trust without an interactive prompt」】

**重要**：CLI 下 `--no-context-files` 只关掉文件发现，**不会**关掉 pi 内建的 system prompt / 工具；要真正减少工具面还得配 `--tools`。

**SDK 等价的资源裁剪**：`DefaultResourceLoader` 选项 `noExtensions` / `noSkills` / `noPromptTemplates` / `noThemes` / `noContextFiles`，以及 `additionalExtensionPaths`、`extensionFactories`（inline）、各自 `*Override` 钩子【源码 `dist/core/resource-loader.d.ts`】。**推荐**：`noExtensions: true`（禁掉外部发现，含 `~/.pi/agent/extensions` 与项目 `.pi/extensions`）+ `extensionFactories: [应用自己的工厂]`——这样「只加载应用提供的扩展」。**已实测**：`noExtensions: true` + inline 工厂后，`extensionsResult.extensions` 只有 `<inline:1>`【实测 §8 实验 5】。

### 5.3 扩展作为「代理 ↔ UI」的桥

扩展能力（`docs/extensions.md`）：
- `pi.registerTool()`：自定义工具（模型可调用）。
- `pi.registerCommand()`：`/` 命令。
- `pi.on()`：生命周期/工具/消息事件（可 `block` 工具、改输入）。
- `pi.registerProvider()`：自定义 provider。
- `pi.setActiveTools()`、`pi.sendMessage()`、`pi.appendEntry()`、`pi.events`。
- **`ctx.ui`**：`select/confirm/input/editor/notify/setStatus/setWidget/setTitle/…`——这正是「弹确认框、上报进度」的接口。

**进程内 SDK 里怎么把 `ctx.ui` 接到 React 对话框？** `AgentSession.bindExtensions(bindings)` 支持传入 `uiContext?: ExtensionUIContext` 与 `mode?: ExtensionMode("tui"|"rpc"|"json"|"print")`【源码 `dist/core/agent-session.d.ts:137-148`、`dist/core/extensions/types.d.ts:209`】。**已实测**：
- 不调 `bindExtensions` 时：`ctx.mode === "print"`、`ctx.hasUI === false`，`ctx.ui.confirm/notify` 是 no-op（宿主实现根本没被调用）。
- 调 `await session.bindExtensions({ uiContext: myUI, mode: "rpc" })` 后：`ctx.mode === "rpc"`、`ctx.hasUI === true`，`confirm("Approve purchase?", …)` 调到了宿主的实现并返回 `true`，`notify("answer=true")` 也到达宿主。

【实测 §8 实验 6】

**落地方式**：实现一个宿主 `ExtensionUIContext`，其 `confirm()` 通过 IPC 让 React 弹模态并 await 结果；`notify/setStatus/setWidget` 单向推送到 UI（进度上报）。官方 RPC 的 UI 子协议字段（`docs/rpc-extension-ui.md`）可作为**对话框契约设计参考**，但我们不需要真的走 JSONL——直接进程内调用更简单。

**注意**：`bindExtensions` 还会 emit `session_start` 并扩展资源。SDK 路径下 **`createAgentSession` 自己不调用 `bindExtensions`**（源码里没有调用点），所以：**不调 `bindExtensions` 就不会触发扩展的 `session_start`、也没有 `commandContextActions`（`newSession/fork/reload` 等）**。应用应在创建后显式 `bindExtensions`（一次或每次 `session_start` 后重绑）。

### 5.4 RPC 的 extension UI 子协议 + `RpcClient` 的缺口

- RPC 模式下扩展 UI 是**请求-应答子协议**：dialog（`select/confirm/input/editor`）发 `extension_ui_request` 并阻塞等 `extension_ui_response`；fire-and-forget（`notify/setStatus/setWidget/setTitle/set_editor_text`）不等回复；带 `timeout` 的 dialog 超时会自动以默认值 resolve。TUI-only 方法（`custom()` 等）在 RPC 下不可用/降级，`ctx.mode === "rpc"`、`ctx.hasUI === true`【文档 `docs/rpc-extension-ui.md`】【源码 `dist/modes/rpc/rpc-mode.js:231`】。
- **能否直接驱动 Electron/React 对话框？** 协议层面可以（就是 4 个 dialog + 若干通知）。**但官方导出的 `RpcClient` 做不到**：
  - `RpcClient` 的公开方法里**没有任何 UI 相关方法**（实测：`Object.getOwnPropertyNames(proto).filter(/ui/i)` → `[]`）。
  - `extension_ui_request` 事件**会**被投递给 `onEvent()` 监听器（`handleLine` 对非 response 记录一律 `listener(data)`），但 `RpcClient` **没有公开的发送 `extension_ui_response` 的 API**（只有私有的 `send`）。
  - 结果：用 `RpcClient` 时 dialog 要么卡住、要么等扩展侧 `timeout` 自动 resolve。

  【源码 `dist/modes/rpc/rpc-client.js:31`（`cliPath ?? "dist/cli.js"` 默认值）、`:42-45`（`spawn("node", …)` + `env:{...process.env,...options.env}`）、`:409-426`（`handleLine`）】【实测 §8 实验 8】
- 官方 `examples/rpc-extension-ui.ts` 因此**不用 `RpcClient`**，而是自己 `spawn` + `StringDecoder` 逐行解析并实现 `handleExtensionUI()`。若要走 RPC，就照它做。

**因此**：本用例要「扩展 UI 直驱 React」，进程内 SDK 的 `bindExtensions({ uiContext })` 是更短、更可测的路径。

---

## 6. 会话存储

### 6.1 位置与格式

- 默认位置：`<agentDir>/sessions/--<sanitized-cwd>--/<timestamp>_<session-id>.jsonl`；`<sanitized-cwd>` = 去掉开头分隔符、把 `/`、`\`、`:` 换成 `-`【文档 `docs/session-format.md`「File Location」】【源码 `getDefaultSessionDirPath()`】。
  - 实测：cwd=`/home/loki/Workspace/mono-space` → `--home-loki-Workspace-mono-space--`；cwd=`/tmp` → `--tmp--`。
- 格式：**JSONL**，每行一个 JSON；首行 `{"type":"session","version":3,...}`，其后是树状条目（`message`/`model_change`/`thinking_level_change`/`usage`/`compaction`/`context_edit`/`branch_summary`/`custom`/`custom_message`/`label`/`session_info`），用 `id`/`parentId` 组成树，支持原地分支【文档 `docs/session-format.md`】。
- 条目类型与「什么进入模型上下文」的规则（`buildContextEntries`/`buildSessionProjection`）在同页；`compaction` 用摘要替换旧历史、`context_edit` 只改未来上下文【文档】。
- 会话可 `--session-id <id>` 指定 ID；`--continue`/`--resume`/`--session`/`--fork` 见 `docs/sessions.md`。

### 6.2 `SessionManager.inMemory()` 的适用性

- `SessionManager.inMemory(cwd = process.cwd(), options?, entries?)` → `persist=false`、`sessionDir=""`，无文件读写【源码 `session-manager`】；文档示例见 `docs/sdk.md#sessionmanager-api` 与 `examples/sdk/11-sessions.ts`。
- **实测**：`createAgentSession({ sessionManager: SessionManager.inMemory(cwd) })` → `session.sessionManager.isPersisted() === false`，`--no-session` 的 RPC 对应 `sessionFile: null`【实测 §8 实验 3、5】。
- **适用**：
  - 「一次性/敏感任务、不想留痕」→ inMemory。
  - 「应用自己管理对话历史」（把 pi 会话当**运行时**，历史存在应用 DB，需要时把 entries 回灌）→ inMemory + 自己持久化。注意 **`SessionManager` 才是模型上下文的权威**：外部历史要通过构造带 entries 的 manager 恢复，直接赋值 `session.agent.state.messages` **不会**替换持久上下文【文档 `docs/sdk.md`「Session storage」】。
  - 「想要 `/resume`、分支、压缩留档、崩溃后可续」→ 用持久化，放到 app 私有目录。
- **建议**（浏览器自动化长任务）：默认**持久化**到 app 私有目录（可审计、可续跑、可导出），对敏感操作提供「不落盘」开关（inMemory）。

### 6.3 XDG 路径建议

- agentDir（配置/密钥/扩展/trust）：`<userData>/pi-agent` → Linux `~/.config/<appName>/pi-agent`。
  - 注意 pi 会在 agentDir 下写 `trust.json`、`npm/`、`sessions/`【文档 `docs/configuration.md`】【实测 `pi list`】。
- 会话（可能较大、增长快）：建议 `<XDG_DATA_HOME 或 ~/.local/share>/<appName>/pi-sessions`，用 `sessionManager`/`--session-dir` 指过去；或退而用 `<userData>/pi-agent/sessions`。
  - Electron 没有直接暴露 XDG_DATA_HOME 的 `getPath` 名，需要手动解析【推断】。

---

## 7. 推荐方案（可直接落地）

### 7.1 进程模型

```
Electron 主进程 (main)
├─ app.whenReady()
│   ├─ 计算 app 私有目录（userData 子目录）
│   ├─ 初始化/读取 app 私有 models.json +（可选）settings.json + auth.json
│   ├─ 用 safeStorage（async API）解密用户 BYOK key（如有）
│   └─ 启动 agent host：
│       方案 A（最简单）：主进程内 utilityProcess.fork(agentHost.js, [], { env: <白名单>, cwd })
│       方案 B（无隔离需求）：主进程直接 createAgentSession()
│
└─ agent host（utilityProcess / 主进程内）
    ├─ createAgentSession({
    │     agentDir: <userData>/pi-agent,          // 显式，压过 PI_CODING_AGENT_DIR
    │     cwd: <浏览器工作目录>,
    │     settingsManager: SettingsManager.inMemory({ defaultTools: [], ... }), // 或读 app 私有 settings.json
    │     sessionManager: SessionManager.inMemory(cwd) | SessionManager.create(cwd, <appSessionDir>),
    │     modelRuntime: <ModelRuntime.create({ authPath, modelsPath })> + setRuntimeApiKey(...),
    │     resourceLoader: new DefaultResourceLoader({ noExtensions: true, extensionFactories: [appBrowserTools] }),
    │     noTools: "builtin",                       // 只留自定义工具
    │   })
    ├─ await session.bindExtensions({ uiContext: ipcUI, mode: "rpc" })   // 关键：接 React 对话框
    ├─ session.subscribe(ev => postMessage 给主进程 → React)            // 流式事件/进度
    └─ 自定义工具 app_browser_* 的实现调用 Playwright/CDP
```

要点：
- **只暴露 `app_browser_*` 自定义工具**（`noTools: "builtin"`），shell/文件工具全禁。
- **确认框**走扩展 `ctx.ui.confirm` → 宿主 `ExtensionUIContext` → IPC → React 模态；**进度**走 `ctx.ui.setStatus/notify` 或 `session.subscribe`。
- 需要崩溃隔离就把 host 放 `utilityProcess`；否则直接主进程。

### 7.2 隔离变量清单

**启动时设置（覆盖外部）**

| 变量 | 值 | 备注 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | `<userData>/pi-agent` | SDK 场景可改用 `agentDir` 选项（更优先） |
| `PI_CODING_AGENT_SESSION_DIR` | `<appSessionDir>` | **仅** CLI/RPC 生效；SDK 用 `sessionManager` |
| `PI_OFFLINE` | `1` | 禁自动联网（模型目录刷新等） |
| `PI_SKIP_VERSION_CHECK` | `1` | 禁最新版本请求 |
| `PI_TELEMETRY` | `0` | 关安装/更新遥测与归属请求头 |
| `HTTP_PROXY`/`HTTPS_PROXY` | 由应用决定 | 勿继承外部 Pi shell |

**启动时删除（防外部 Pi 注入污染）**

`AI_AGENT`、`PI_CODING_AGENT`、`PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`、`PI_HARDWARE_CURSOR`、`PI_HYPERLINKS`、`PI_IMAGE_PROTOCOL`、`PI_TRUE_COLOR`、`PI_TUI_ESC_TIMEOUT`、`VISUAL`、`EDITOR`、`PI_PACKAGE_DIR`。

**provider key（按产品决策）**

若要严格「不吃用户已有 key」：删除所有 provider key 环境变量（§4.2 列表），只从应用设置注入 `setRuntimeApiKey`。进程内 SDK 无法只对单个会话屏蔽 `process.env`（§4.1），因此**最强隔离是子进程 + 白名单 `env`**。

**可选加固**：fork/私有发布改 `piConfig.name`/`configDir`，让应用只认 `GAME-ASSET-BUTLER_CODING_AGENT_DIR`（§2.2）。非必需。

### 7.3 依赖与打包（Linux）

```jsonc
// package.json
"dependencies": { "@earendil-works/pi-coding-agent": "0.87.1" }  // 精确锁版本
```

```yaml
# electron-builder 关键项
asar: true
asarUnpack:
  - "**/*.node"                                              # pi-tui 的 linux-x64/arm64 prebuild
  - "**/@earendil-works/pi-coding-agent/dist/bundle/**"      # 若用 RPC 子进程入口
  - "**/*.wasm"                                              # photon / esbuild wasm
linux:
  target: [AppImage, deb]
  arch: [x64, arm64]
```

- 进程内 SDK：仅需保证 Electron 内置 Node ≥ 22.19（**具体 Electron 版本待定 → §9**），以及 `.node` 可加载（`asarUnpack`）。
- RPC 子进程：用 `ELECTRON_RUN_AS_NODE=1` + `process.execPath` 启动 `process.resourcesPath/app.asar.unpacked/.../rpc-entry.js`；**不要**用 `child_process.spawn` 传 asar 内路径（官方限制），**不要**依赖系统 `node`【文档 Electron asar】【源码 `rpc-client.js:42`】。
- 双架构：`pi-tui` 已带 linux-x64/arm64 prebuild，无需自编译；arm64 交叉构建见 electron-builder Docker/QEMU 流程。

### 7.4 模型配置

- **本地 Ollama**：app 私有 `models.json` 写 OpenAI 兼容端点（§4.4），`defaultProvider: "ollama"`。
- **用户 BYOK 云 model**：设置界面输入 →（可选 safeStorage 加密存盘）→ 启动 `setRuntimeApiKey(provider, key)`；`models.json` 只放端点/模型元数据，不放明文 key；或 `apiKey: "!secret-tool lookup ..."`。
- **settings 最小化**：`SettingsManager.inMemory({ defaultProvider, defaultModel, defaultThinkingLevel, defaultTools: [], compaction… })`，避免读任何外部 `settings.json`。

---

## 8. 验证方式（本机只读/临时实验记录）

全部实验在 Linux x64 / node v24.20.0 / pi 0.87.1 上执行；`EXP=$(mktemp -d /tmp/piiso.XXXXXX)`，**未写入 `~/.pi/agent`**（仅 `pi list` 只读读取真实目录）。

1. **派生环境变量名 + configDir 改名**（实验 1）
   ```bash
   mkdir -p $EXP/fakepkg
   cat > $EXP/fakepkg/package.json <<'EOF'
   {"name":"@game/asset-butler-agent","version":"9.9.9","type":"module",
    "piConfig":{"name":"game-asset-butler","configDir":".game-asset-butler"}}
   EOF
   PI_PACKAGE_DIR=$EXP/fakepkg pi --help | grep CODING_AGENT
   # → GAME-ASSET-BUTLER_CODING_AGENT_DIR - Config directory (default: ~/.game-asset-butler/agent)
   ```

2. **`PI_CODING_AGENT_DIR` 确实切换配置目录**（实验 2）
   ```bash
   mkdir -p $EXP/a1 && echo '{"packages":["npm:@example/pi-tools@1.0.0"]}' > $EXP/a1/settings.json
   PI_CODING_AGENT_DIR=$EXP/a1 PI_OFFLINE=1 pi list
   # → 只列出 @example/pi-tools（真实 ~/.pi/agent 的包一个都没出现）
   ```

3. **会话目录优先级 / 陈旧外部 env 无影响 / `--no-session`**（实验 3，RPC `get_state`）
   ```bash
   # a1/models.json 定义 ollama 端点（离线可用）
   printf '{"id":"1","type":"get_state"}\n' | \
     env PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_CODING_AGENT_DIR=$EXP/a1 \
     PI_CODING_AGENT_SESSION_DIR=$EXP/s1 pi --mode rpc
   # → data.sessionFile 在 $EXP/s1/…；data.model = ollama/qwen2.5-coder:7b
   # 加 --session-dir $EXP/s2            → sessionFile 在 s2（CLI 覆盖 env）
   # 不设 session env                   → $EXP/a1/sessions/--home-loki-Workspace-mono-space--/…
   # 传 PI_MODEL=claude-nonexistent 等   → 仍是 ollama，thinking=off（陈旧变量无影响）
   # 加 --no-session                    → sessionFile: null
   ```

4. **Node spawn 的 env 语义**（实验 4）
   ```bash
   node -e 'const{spawnSync}=require("node:child_process");
   const r=spawnSync(process.execPath,["-e","console.log(JSON.stringify({FOO:process.env.FOO,HAS:Object.prototype.hasOwnProperty.call(process.env,\"FOO\")}))"],
   {env:{...process.env,FOO:undefined,BAR:"1"},encoding:"utf8"});console.log(r.stdout)'
   # → {"BAR":"1","HAS":false}  ⇒ undefined 值会被真正省略
   ```

5. **SDK 工具裁剪矩阵 + 显式 agentDir 压过 env**（实验 5，`/tmp/sdk-test2.mjs`）
   - 用 `DefaultResourceLoader({noExtensions:true, extensionFactories:[注册 app_browser_action]})`，分别以默认 / `noTools:"builtin"` / `"all"` / `tools:[]` / `tools:["read"]` / `tools:["app_browser_action"]` 建会话，打印 `session.getActiveToolNames()` → 结果见 §5.1 表。
   - 运行命令带 `PI_CODING_AGENT_DIR=/nonexistent/should/not/matter`，显式传 `agentDir=$EXP/a1` → 仍解析出 `ollama/qwen2.5-coder:7b`（证明显式选项胜）。
   - `extensionsResult.extensions` = `["<inline:1>"]`。

6. **SDK 扩展 UI 桥**（实验 6，`/tmp/sdk-test.mjs`）
   - 未 `bindExtensions`：`cmd ctx.mode=print ctx.hasUI=false`，宿主 `confirm/notify` 完全没被调用。
   - `await session.bindExtensions({ uiContext: hostUI, mode:"rpc" })` 后：`cmd ctx.mode=rpc ctx.hasUI=true`；宿主收到 `confirm: Approve purchase? / Buy the item?` 与 `notify(info): answer=true`。

7. **SDK 读 `PI_CODING_AGENT_DIR` 但不读 `PI_CODING_AGENT_SESSION_DIR`**（实验 7，`/tmp/sdk-env-test.mjs`）
   ```bash
   PI_CODING_AGENT_DIR=$EXP/envagent PI_CODING_AGENT_SESSION_DIR=$EXP/envsess node /tmp/sdk-env-test.mjs
   # → sessionFile: $EXP/envagent/sessions/--tmp--/…   （envsess 目录被创建但为空）
   ```

8. **`RpcClient` 无扩展 UI 应答能力**（实验 8，`/tmp/rpc-ui-test.mjs`）
   - `Object.getOwnPropertyNames(RpcClient.prototype).filter(/ui/i)` → `[]`
   - `typeof client.send` → `function`（但为私有）
   - 扩展 UI 记录会进入 `onEvent` 监听器（观察到 `setTitle/setWidget/setStatus`）。

9. **`auth.json` 明文 + `0600`**（只读）
   ```bash
   stat -c '%a %n' ~/.pi/agent/auth.json   # → 600
   # dist/core/auth-storage.js: AUTH_FILE_WRITE_OPTIONS = { encoding:"utf-8", mode:0o600 }，JSON.stringify，无加密
   ```

10. **Electron/Linux 事实**来自官方文档检索（`electron/electron`、`electron-userland/electron-builder`）：
    - `safeStorage.getSelectedStorageBackend()` 取值与 `basic_text` = hardcoded plaintext password（unprotected）；
    - `setUsePlainTextEncryption`、async API 弃用（Electron 46）；
    - asar：`exec`/`spawn` 不能执行 asar 内文件、`.node` 用 `--unpack`、`app.asar.unpacked`；
    - `utilityProcess.fork(modulePath, args, {env,cwd,stdio})`（ready 后可用）；
    - `userData`(Linux) = `$XDG_CONFIG_HOME`/`~/.config` + appName。

---

## 9. 未能验证 / 开放问题

1. **目标 Electron 版本的内置 Node `>=22.19.0` 是否满足**：需查选定 Electron 的 release notes（未在本机验证，因为没有安装 Electron）。这决定进程内 SDK 是否可行；不满足则必须走 `ELECTRON_RUN_AS_NODE` + 更高版本 Node 或子进程方案。
2. **`safeStorage.isEncryptionAvailable()` 在 Linux `basic_text` 后端下返回 true 还是 false**：官方 API 文档未在检索结果中给出该方法的 Linux 语义；建议**不要**用它单独判定安全性，改用已明确文档化的 `getSelectedStorageBackend() === "basic_text"`（§4.5）。需在目标 Electron 版本上实测。
3. **`pi --help` 之外的参数细节**会随版本变化：本文档所有 CLI 结论绑定 **0.87.1**；升级必须重读 `docs/cli.md` / `pi --help`。
4. **asar 内加载 `pi-tui` 的 `.node` 的确切行为**（Electron 是否会把 `.node` 从 asar 解包到临时目录）：官方建议显式 `asarUnpack`；本文按「显式解包」给方案，但未在真实 AppImage/deb 上跑通验证。
5. **`utilityProcess` 中加载 asar 内 JS 与 `.node` 的路径解析**：`getNativeModuleCandidates()` 会尝试 `require.resolve` 与 `dirname(process.execPath)`（§3.3），在 `utilityProcess` 下的 `process.execPath` 指向 Electron 可执行文件，需实测确认 `.node` 仍能从 `app.asar.unpacked/node_modules/...` 解析到。
6. **`RpcClient` 是否会在后续版本补上扩展 UI API**：0.87.1 没有；若将来补了，RPC 方案的成本会下降。
7. **`PI_CODING_AGENT_DIR` 含连字符的派生名在 shell/`env` 下的可移植性**：`env 'A-B=1' cmd` 在本机可用，但不同 shell 行为未逐一验证；不影响 Node `process.env` 读取，只影响用 shell 传参。
8. **模型目录联网行为**：`PI_OFFLINE=1` 只关「自动联网」，显式刷新（`pi update --models`、`/model` 重载）是否仍会联网，未逐一验证。
9. **浏览器自动化工具与模型上下文预算**：未涉及；属于应用侧设计（工具结果截断、`compaction` 设置），非本 issue 的隔离问题。
