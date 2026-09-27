# 验证 33：全面测试（一次把所有层都跑一遍，并做真实应用验收遍历）

日期：2026-09-27。范围：静态检查 → 单元 → 构建 → e2e → **真实应用 + 真实台账 + 真实 Humble 接口的验收遍历**
→ 覆盖率盲区审计（由独立 subagent 只读完成）。

## 0. 结论先行

**跑起来的东西全绿**：typecheck 0 错 / lint 干净 / 单测 319（本次修 bug 后 322）/ 构建通过 / e2e 6 passed 2 skipped。

**但「全面测试」抓出了 4 个真问题**（这正是它的价值）：

| # | 问题 | 性质 | 本次处理 |
|---|---|---|---|
| 1 | **「导出 JSON / CSV」没有任何出口** —— 主进程算出 499077 字符的 JSON、251423 字符的 CSV，渲染层只拿 `text.length` 显示一句提示，**数据被丢掉**；全仓无 `showSaveDialog` / `clipboard` / 导出用途的 `writeFile` | 功能等于没做 | **已修** → `docs/verify/36`：点按钮真弹原生保存对话框并写盘（真机 JSON 538745 字节 / CSV 256787 字节、权限 600） |
| 2 | **调试日志面板空闲时不再轮询** —— 一轮结束就把 interval 停掉，于是「面板开着时启动的新任务永远不出现」（实测缓冲 19 条 vs 面板 0 条，点刷新才补上） | 真 bug（本次修） | **已修**：`log-poll.ts` 纯函数 + 3 条测试；实测见 §3 |
| 3 | **`mono-space:extension-command` 是一条未接线的下行通道** —— preload 里有监听，**全仓没有任何发送方** | 死接线（无害） | **已删**：随「移除自带扩展 + 移除 MCP」一起废掉 —— 生产里不再打包扩展（只剩 `tests/fixtures/extension-mv3*` 这个夹具，且它只上报不接收命令），主进程无人发、页内也无人听。上行（`extension-report`）确认还活着（`store-session` 加载 bridge、`browser/index.ts` 消费上报） |
| 4 | **「未揭示」与「无法揭示」在数据层分不开** —— 48 条未揭示里包含**页面根本没有揭示控件**的行（实测该单 4 行：三行只有「点击此处领取密钥」的商店链接、一行写着「此密钥已过期」）；界面上的橙色徽章会**永远**提示「该动这一单」 | 状态模型缺口 | **已修** → `docs/verify/35`：`keys.no_code_reason` 逐行记「为什么没码」（`expired` / `exhausted` / `link_only` / `unknown`），界面单占一列显示徽章；**全库 85 条无码行已 100% 有缘由**（两趟真跑，见 35 §8）。仍未做的：不把「无法揭示」当成新的 `reveal_status` 取值（缘由是另一条轴，不覆盖页面事实） |

另有一条**正面证据**值得记下：agent 在「页面上没有揭示控件」时**没有猜着点**，逐行说明了原因并交人工确认——
这正是 ADR-0005/提示词纪律想要的行为。

## 1. 各层结果（命令 → 结果）

| 层 | 命令 | 结果 |
|---|---|---|
| 静态类型（node） | `pnpm typecheck:node` | 0 错 |
| 静态类型（web） | `pnpm typecheck:web` | 0 错 |
| 风格 / lint | `pnpm lint`（biome，105 文件） | 干净 |
| 单元 | `pnpm test:unit`（vitest） | **319 passed / 28 文件**（修问题 2 后 322 / 29 文件） |
| 构建 | `pnpm build` | 通过（renderer / main / preload 三段 + 两个渲染入口） |
| e2e | `DISPLAY=:0 pnpm test:e2e`（playwright 驱动真实 Electron） | **6 passed / 2 skipped**（跳过的是两条需登录的手动用例） |
| 真实验收遍历 | `/tmp/accept.sh`（见 §2） | 33 通过 / 5 失败 → **5 项全部无效**（4 项我的脚本传参 bug + 1 项样本选错），见 §2.3 |

e2e 明细：client hints 注入 ✓ · MV3 扩展装载+热替换 ✓ · 订单主视图+明细（虚拟滚动/四态筛选/状态双列/不含码）✓ ·
空台账空态 ✓ · 订单无 key 明细空态 ✓ · preload contextBridge 往返 ✓ ·（手动）未登录出网 ·（手动）同步未登录提示。

## 2. 真实应用验收遍历

### 2.1 覆盖了什么（e2e 不覆盖的用户可见流程）

冷启动空库 → 迁移动态链 · 真实台账 68 单 · **搜索**（含「没搜到」空态）· **导出按钮**真实行为 ·
**真实 agent 任务**（读取并揭示，含一次真揭示尝试）· 调试窗口（单实例 / 运行中→空闲 / 清空）·
**窗口控制**（最大化 ↔ 还原真实点击）· 明细四态筛选 · 明细不含兑换码明文 · 审计与库一致性。

### 2.2 通过项（33 项，摘录）

```
空库启动后订单 0 条、空态可见；全新库无 orders.purchased_at（v5 删列在空库也成立）
真库 68 单；搜索 synty → 筛出 8 行 = 库里匹配数 8；清空搜索恢复 68
导出提示：JSON（499077 字符）、CSV（251423 字符）；导出后 ~/Downloads 文件数不变 ← 问题 1 的证据
任务运行中状态条语气 busy → 结束回 info；调试窗口 运行中… → 空闲
调试窗口：条目存在、含 tool 类记录、日志里只有本轮（无上一轮痕迹）
明细：全部/未揭示/已揭示未兑换/已兑换 四态文案；整页 HTML 无兑换码明文
调试窗口单实例（连点两次仍 1 个）；清空生效（0 条）
窗口控制：点最大化 → 按钮变「还原」；点还原 → 变回「最大化」
审计有内容、最后一条 keys_ingest；库 1087 keys / 68 单
```

### 2.3 5 个「失败」的归属（全部是**测试脚本自身**的问题，不是产品问题）

1. **4 项**报出 `Node.js v24.20.0` —— 我的 `sql()` 辅助函数只转发一个额外参数（`${2:-$DB_REAL}`），
   而我调用时把**订单号**传成了库路径 ⇒ node 打开失败、打印错误末行。**这 4 项是无效结果**。
   其中「库中该单未揭示数（读取前）」还因此**假通过**（我的 `chk_nonempty` 太弱，把报错文本当成了值）。
2. **1 项**是**样本选错**：「★ 真实揭示：该单未揭示数归零」失败 —— 我挑的是「第一个带未揭示徽章的订单」，
   而该单（`ErUyuaeeuShZpB8Z`）**页面上根本没有揭示控件**（见 §0 问题 4 与 §4）。agent 的自述证明：
   它逐行核对了页面、整页检索揭示控件为空，于是**没有点击任何东西**并交人工确认 —— **产品行为正确，是我的期望错了**。

### 2.4 我的验收脚本自身的缺陷（诚实备案）

- `sql()` 传参 bug（上面第 1 条）。
- **筛选计数检查是同义反复**：`chk "明细筛选 $f 的总数文案" "$UI_TOTAL" "$(echo "$UI_TOTAL" | grep -qE '^共 [0-9]+ 条$' && echo "$UI_TOTAL")"` ——
  拿变量和它自己比，只验了**格式**，没验**数值**。这几项「通过」不构成对数值正确性的证据（数值正确性由 e2e 覆盖）。
- 空态检查只取了 `textContent.slice(0,8)`，只能证明「有字」，不能证明文案正确。

## 3. 问题 2 的修复与验证（本次唯一改动）

**症状**（决定性证据）：主进程缓冲 `agent.log()` 返回 **19 条**、面板显示 **0 条 + 暂无记录**；
点一次「刷新」⇒ 立刻 **19 条**。⇒ 数据一直在，是面板没在轮询。

**根因**：面板的 effect 以 `running` 为依赖，`if (!running) return` 在空闲时**不设 interval**，
于是一轮结束后永久停轮询，「开着面板时启动的新任务」永远不会自己出现。
（这个缺陷**原设计就有**，但面板原先嵌在台账页、每次都是新打开的，被掩盖；改成常驻独立窗口后暴露。）

**改法**：抽出 `src/renderer/src/ledger/log-poll.ts`（纯函数 `logPollIntervalMs`：运行中 2500ms / 空闲 5000ms，
**永远返回有限间隔，绝不返回「不轮询」**），面板里删掉提前 return；3 条测试（含一条专门钉「空闲也要返回有限间隔」）。
**反向验证**：把实现改回「空闲返回 NaN」，3 条测试立刻变红；还原后 322 全绿。

**真实应用验证**（`/tmp/verify-idle-poll.sh`，用 `agent-browser` 驱动真实窗口）：

```
先开调试窗口（此时空闲）→ 面板 0 条、状态「空闲」
启动任务，**全程不点刷新**
  → 12s 后面板自己变成 3 条
  → 20s 后 5 条，条目类别序列 = tool,tool,tool,turn_text,run_start
```

⇒ 空闲时打开的窗口靠轮询就能看见新任务（旧行为下会一直停在 0 条，直到手点刷新）。

## 4. 覆盖率盲区（由独立 subagent 只读审计，我抽查确证）

- **21 个源文件不被任何测试文件 import**（含 `main/index.ts`、`ipc/*`、`window-controls.ts`、`ui/*`、
  `AgentLogPanel/Row`、`OrdersPage` 等）—— 重灾区是**接线层**（装配 / IPC 注册 / 窗口控制 / 纯 UI 组件）。
  业务纯逻辑（data / sync / agent 逻辑 / browser 纯函数）基本都有引用。
- **`src/main/ipc/*` 的所有导出在测试里零出现**；`runAgent` 零覆盖。
- **14 个 agent 工具里 4 个的 handler 从未被执行**：`monospace_ledger_stats`、`monospace_orders_sync`、
  `monospace_errors`、`monospace_screenshot`（只断言了 `layer`/描述）。`monospace_act` 只测了
  `click/goto/scroll`，`dblclick/hover/drag/fill/type/press_key/upload/dialog` 分支未测。
- **可疑的测试质量**（摘录）：`serialize.test.ts:105` 断言自己构造的常量恒真；`tools.test.ts:376` /
  `session.test.ts:55` 等「断言某工具不存在」的恒真缺席断言；`session.test.ts:95` / `tools.test.ts:472` /
  `prompts.test.ts:23` 对硬编码文案做否定断言；`query.test.ts:9` 的 `toBeTruthy` 弱断言；
  `host.test.ts` 把整个浏览器动作层 mock 掉（真实滚动/DOM 动作零执行）；
  `ipc/__tests__/sync.test.ts:46` 断言假仓储的硬编码返回值。
- **我抽查确证的一条**：`mono-space:extension-command`（下行）在 preload 有监听、**全仓无发送方**
  （唯一的下行 `webContents.send` 是 `window-controls.ts:48` 的 `maximized-changed`）⇒ 未接线。

> 审计是**只读**的（未改文件、未跑测试）；其结论我按「确证 / 推测」复核，抽查项与它一致。
> 它也修正了我一个前提：`src/shared/ipc-contract.ts` 是**纯类型文件**，里面没有通道字符串。

## 5. 打包层（本次已跑）

`pnpm build:linux` → `dist/MonoSpace-0.1.0.AppImage`，**143.8 MB**，electron-builder 26.16.1 /
Electron **44.4.5**（符合版本红线）。

**不是只看「构建成功」—— 产物真跑了**（临时 `MS_LEDGER_DB`，不碰真实台账）：

```
渲染页从 asar 内加载：file:///tmp/.mount_MonoSp…/resources/app.asar/out/renderer/index.html
品牌条可见、空台账空态可渲染、window.api.ping 往返 = pong:hello ⇒ 打包内 preload 桥正常
临时库迁移链跑到 schema_version = 5
asar 头解析：renderer/index.html ✓、renderer/debug.html ✓、out/main/index.js ✓、
            out/preload/index.cjs + bridge.cjs ✓（sandboxed preload 产的是 .cjs，不是 .js）
已删代码无残留：redeem/flow、page-driver、extension-mv3、bundled-extensions 均 0 处
               （`content.js` 的命中全在 node_modules/openai 里）
```

**发现一个打磨缺口（未修）**：`default Electron icon is used  reason=application icon is not set` ——
应用没有设图标，AppImage 里是 Electron 默认图标。不影响功能，但属于「精致」范围。

electron-builder 另报了 `missing optional dependencies [@esbuild/*]`：pnpm 10+ 不自动装传递平台二进制；
这些是**构建期**依赖，运行期不用，实测产物可跑，故无害。

## 6. 明确没有验证到的（诚实边界）

1. **真实兑换（不可逆、消耗密钥）**：代理驱动的兑换只过单测，**从未真跑** —— 需要一个可牺牲的密钥。
2. **两条 e2e 手动用例**（未登录出网 / 同步未登录提示）默认 `skip`；需要 `MS_NET_TESTS=1` 且会真出网。
3. **登录流程**（`tasks:login` 打开 Humble / Epic 可见登录窗）无测试、本次未跑（会动到登录态）。
4. **48 条未揭示里到底有多少是「无法揭示」**未逐一核对 —— 只确证了 `ErUyuaeeuShZpB8Z` 的 4 条是这一类。
5. **agent 任务的判定质量**（平台逐行判断、是否漏读行）只在少数单上观测过，不能外推。
6. AppImage 只验证了**本机可跑**，未在其他发行版/无 FUSE 环境验证；也未验证自动更新（`app-update.yml` 已生成但无发布源）。

## 7. 方法

- 自动化：`pnpm typecheck` / `pnpm lint` / `pnpm test:unit` / `pnpm build` / `DISPLAY=:0 pnpm test:e2e`。
- 真实遍历：`/tmp/accept.sh`（Electron + `--remote-debugging-port` + `agent-browser` 驱动真实窗口与真实页面；
  `MS_LEDGER_DB` 指向临时库做冷启动，其余用真实台账）。
- 覆盖率审计：独立 subagent 只读扫描（import 传递闭包 + 导出符号在测试文本里的零出现 + IPC/工具双向对照）。
- **凡是我自己写的检查脚本，失败项都先归因到「仪器」还是「产品」才下结论**（§2.3 就是这么做出来的）。
