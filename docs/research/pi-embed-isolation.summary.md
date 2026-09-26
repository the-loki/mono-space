# Pi 内嵌隔离研究摘要（issue #4，目标平台 Linux）

- 结论：内嵌形态选**进程内 SDK `createAgentSession`**（Electron 主进程或 `utilityProcess`）；不要用 CLI/`RpcClient`。理由：事件零跨进程、扩展 UI 可直驱 React、不依赖系统 `node`、凭据可纯内存。
- 隔离：显式 `agentDir`（压过 `PI_CODING_AGENT_DIR`）+ `SessionManager.inMemory()` 或 app 私有会话目录；清理 `AI_AGENT/PI_CODING_AGENT/PI_SESSION_*/PI_MODEL/...` 与 provider key env；设 `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`。
- 关键差异：SDK **不读** `PI_CODING_AGENT_SESSION_DIR`；外部 Pi 注入的 `PI_MODEL/PI_PROVIDER/PI_SESSION_ID` 等 Pi 自己只写不读，实测无污染。
- 工具/UI：`noTools:"builtin"` + inline extension 只暴露 `app_browser_*`；`session.bindExtensions({uiContext,mode:"rpc"})` 已实测可驱动 React 确认框与通知。
- 依赖/打包：锁 `@earendil-works/pi-coding-agent@0.87.1`，不依赖全局 `pi`；Linux 需 `asarUnpack **/*.node` 与子进程入口，Electron 内置 Node 须 ≥22.19；AppImage/deb 出 x64+arm64。
- 凭据优先级：runtime `--api-key`/`setRuntimeApiKey` > `auth.json` > `models.json#apiKey` > env；BYOK 建议内存注入或 `!secret-tool …`；Ollama 走 `models.json` 兼容端点。
- Linux 凭据风险：`safeStorage` 无桌面密钥环时回退 `basic_text`（硬编码口令，明文级）；应据 `getSelectedStorageBackend()` 判定，勿单独信 `isEncryptionAvailable()`；pi 的 `auth.json` 本身明文且仅 `0600`。
- 详情与文件级证据：`docs/research/pi-embed-isolation.md`（含 8 个本机只读实验与 9 项开放问题）。
