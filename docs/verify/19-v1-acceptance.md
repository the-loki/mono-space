# 验收 `#27`：v1 端到端与首次登录 checklist

对应 `docs/spec/14-v1-slices.md` §7。本文件记录**已验证的部分**与**只能在真实登录下完成的部分**。

环境：Ubuntu 26.04.1（kernel `7.0.0-34-generic`）、Node `v24.20.0`、pnpm `10.17.1`、
Electron `44.4.5`（Chrome `152.0.7977.130` / Node `24.21.0`）、显示 `:198`、`--no-sandbox`。

---

## 1. 已在无登录条件下验证（自动化证据）

### 1.1 构建与测试

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 单元测试 | **211 通过 / 23 文件** | `pnpm test:unit` |
| e2e（Playwright + 真实 Electron） | **5 通过 + 1 手动跳过** | `pnpm test:e2e`（`DISPLAY=:198`） |
| 类型检查 | 通过 | `pnpm typecheck`（node + web 两个 project） |
| Lint | 通过 | `pnpm lint`（biome，73 文件） |
| AppImage 产物 | **125 MB** | `dist/MonoSpace-0.1.0.AppImage` |

### 1.2 AppImage 装完即启动 ✅

对 **AppImage 本体**（不是 `linux-unpacked/`）直接启动并断言：

```
APPIMAGE_TITLE="MonoSpace"
APPIMAGE_EXTENSIONS=["MonoSpace store helper"]
```

即：AppImage 能拉起、主窗口标题正确，且打包进去的两个 MV3 扩展都能被**加载**。
（**2026-09-27 更新**：兑换改为代理驱动后，打包**不再带任何 MV3 扩展**（ADR-0005），
上面这份输出是当时的记录；MV3 装载能力仍由 `browser/extension-host.ts` +
`tests/e2e/browser-skeleton.spec.ts` 的夹具验证。）
（本机 `kernel.apparmor_restrict_unprivileged_userns=1`，`chrome-sandbox` 不可用，
故用 `--no-sandbox`；Ubuntu 24+ 的 AppRun 会自动补这个参数——见 `docs/verify/17-electron-packaging.md`。）

### 1.3 client hints 注入生效 ✅

`docs/adr/0002` 的硬约束。离线 echo 服务端断言：store 会话出网带上
`sec-ch-ua`（含 Chromium 版本）、`sec-ch-ua-mobile: ?0`、`sec-ch-ua-platform: "Linux"`。

真实站点冒烟（`MS_NET_TESTS=1` 手动、允许重试，因为 Cloudflare 是**有状态**的）：

```
[网络冒烟] https://www.fab.com/ [ 200 ]
[网络冒烟] https://www.epicgames.com/account/code-redemption [ 403, 200 ]
```

### 1.4 台账（S0 读侧）✅

- 2000 行临时库：虚拟滚动渲染、三态筛选切换、状态双列正确；
- **列表不出现兑换码明文**（IPC 白名单投影 + e2e 断言）；
- 空库显示空态。

### 1.5 脱敏与零遥测 ✅

| 项 | 结果 | 检查方式 |
| --- | --- | --- |
| 代码里无日志语句 | ✅ | `grep -rn "console\.\|electron-log\|Sentry" src/` → **0 命中** |
| 无遥测库 | ✅ | 同上（无 analytics/posthog/mixpanel 等） |
| 渲染进程不发外部请求 | ✅ | `grep -rn "fetch(\|sendBeacon" src/renderer src/preload` → **0 命中** |
| 出网目标只有 Humble / Epic | ✅ | 主进程内 URL 常量仅 `humblebundle.com`、`epicgames.com` |
| key 明文不进 note/日志 | ✅ | 揭示 note 已脱敏，并有回归断言（`state.test.ts`「note 里不放 key 明文」） |

### 1.6 `needs_human` 与中止整批（离线，mock 页面） ✅

- 未登记错误码 → `needs_human`（不猜测、不重试）；
- 会话失效（`unauthorized`）/ 风控 → `needs_human` 且 **`abortBatch: true`**；
- 未知错误分类 → `needs_human`。

### 1.7 同步链路真的接通 ✅

未登录时 Humble 的只读 GET 返回 401（研究 §4.1：GET 不受 Cloudflare 阻挡），所以这条
**不依赖账号但确定性**地证明了整条链路：

```
SYNC_BUTTON_VISIBLE=true
SYNC_RESULT={"ok":false,"reason":"not-logged-in","message":"未登录 Humble（请先在内嵌窗口登录）"}
```

即：渲染进程按钮 → preload API → IPC → **store 会话 fetch** → `humblebundle.com` → 结构化错误。
固化为 `tests/e2e/sync-wiring.spec.ts`（`MS_NET_TESTS=1` 手动开，因为需要网络）。

### 1.8 不可逆操作前的闸门（离线，mock 页面） ✅

- 揭示：**只读预检 + 单条试探**；试探发现 `redeemed_key_val` 已存在 → **一次都不写**；
- 揭示：**恢复=重快照不重放**——首次失败可重试时，重试前重新试探，发现已落地就收工
  （测试断言 `submit` 只被调用 1 次）；
- 兑换：**最终成功判据 = `fab.com/library` 出现该 listing**；页面报成功但库里没有 → `needs_human`。

---

## 2. 只能在真实登录下完成（HITL）

以下需要**真实 Epic / Humble 账号**，不在自动验收范围内。这是 `#14` §7 的
「首次登录 checklist」，也是 `#12`/`#16`/`#18`/`#22`/`#25`/`#26` 的残差汇聚点。

> **2026-09-27 复核**：本节已按 ADR-0005（兑换改代理驱动，代码驱动栈已删）/ ADR-0006（平台判断交给 agent）
> 对齐 —— 原来引用 `needs_human`、中止整批、页面选择器校准的项**已作废**，不能照旧勾。
> 同时把本轮**真跑过**的项连证据勾上（证据都在对应 verify 文档里，不靠回忆）。

### 2.1 首次运行引导

- [x] 内嵌窗口登录 **Humble**（登录态落在 `persist:store` 分区）—— 证据：真库 68 单来自该账号，
  且多轮任务在内嵌浏览器里真点了订单页的揭示控件（返回的是发行方文案，不是登录页）。
- [ ] 内嵌窗口登录 **Epic**（Epic 会话覆盖 `epicgames.com` + `fab.com`）—— **未验**，无实测记录。
- [x] 首次同步跑通（点台账页「同步」）—— 真接口四趟验证见 `docs/verify/32-api-key-supplement.md`。
- [x] 主界面显示台账 —— 见 `docs/verify/33-full-test.md` §1 与各处截图。

### 2.2 残差回填（每条都要把实测结果写回对应文档）

| 残差 | 来源 | 现状 |
| --- | --- | --- |
| Fab profile → **Redeem Code 的确切 href** | `#12` | **不再阻塞**：ADR-0005 后由 agent 现场判断页面语义，应用侧不再需要这个选择器。文档价值仍在 |
| Epic 账号兑换页**实际渲染文案 vs `#18` 错误码**的对照 | `#12`/`#18` | **部分回填**：本轮真跑观测到「本产品密钥暂时耗尽」「该产品密钥暂时已用尽」「此密钥已过期,不能再兑换」等真实文案（见 `docs/verify/34`/`35`），已作为 `expired`/`exhausted` 取值的实证来源 |
| 登录态下 `/i/users/me` 返回 **200**、一次真实 claim **全程无 challenge** | `#16` | **未验**（真接口验证只覆盖了订单列表 API） |
| Epic **2FA 的实际方法**与「约 30 天重索」的实测 | `#18` | **未验** |
| Humble 订单列表**是否真的无服务端分页**、真实库耗时/内存 | `#22` | **部分**：真库 68 单一次拉全（未见分页参数），精确耗时/内存未测 |
| 揭示控件定位 | `#25` | 已由 agent 接管（原 `src/main/reveal/` 已删） |
| Epic 兑换页 DOM 选择器校准 | `#26` | 已随代码驱动栈删除（ADR-0005；现行见 `docs/spec/12` §11） |

### 2.3 端到端

- [~] 单条**揭示**成功（Humble）：状态 `unrevealed → revealed`，台账出现「已揭示未兑换」——
  **点击链路真跑过很多次**（`docs/verify/34`：14 单逐行点，`35` §8：另 20 单），
  但**没有一条拿到新码**：发行方耗尽 / 已过期 / 页面根本没有揭示控件（真实库已无「能出码」的未揭示行）。
  也就是说「点得动」已验，「点得出码」未验 —— 需等库里有新的可揭示订单。
- [ ] 单条**兑换**成功（Fab）：My Library 校验通过，状态变「已兑换」—— **未跑**：真跑要消耗一条密钥（不可逆），
  需用户指一个可牺牲的 key。ADR-0005 后这条链路是**代理驱动**，目前只有单测覆盖。
- ~~未知错误码 → `needs_human`~~ **作废**：代码驱动兑换栈已删除（ADR-0005），`needs_human` 不再是应用侧概念。
  现行等价行为：agent 在拿不到码/看不懂页面时**如实说明并停手**（`docs/verify/34` 实测：4 行无揭示控件、一行都没点），
  缘由逐行落在台账「无码缘由」列（`docs/verify/35`）。
- ~~会话失效 → 中止整批、重登后重跑~~ **作废**：批处理栈已随 ADR-0005 删除。
  现行等价行为：agent 单任务运行，异常时如实报告（未观测到会话失效实例，故不声称已验证）。

---

## 3. 执行方式（给人看的）

```bash
# 构建产物
pnpm build:linux                     # → dist/MonoSpace-0.1.0.AppImage

# 带测试钩子启动（便于观察扩展是否装载；日常使用不需要）
MS_TEST=1 DISPLAY=:198 dist/MonoSpace-0.1.0.AppImage --no-sandbox

# 自动测试
pnpm test:unit                       # 211 个
DISPLAY=:198 pnpm test:e2e           # 5 个（+1 手动）

# 真实站点冒烟（Cloudflare 有状态，允许重试）
MS_NET_TESTS=1 DISPLAY=:198 pnpm exec playwright test browser-skeleton -g 手动
```

> **注**：`#27` 的 DoD 要求「发现的问题各自开新 issue」。本轮验收已发现并关闭 1 个缺口：
> `#28`（同步模块没有入口、台账无数据来源）。

## 实测校准：真实 DOM（2026-09-26，已登录真实账号）

用 MonoSpace 自带的浏览器能力（只读探测 + a11y 快照）在真实页面上核对出的结构。

### 密钥页 `/home/keys`

| 项 | 实测结果 |
| --- | --- |
| 密钥表 | `table > tr`，表头 `th.platform` / `th.game-name` / `th.redeemer-cell`；**首页 21 行，共 48 页** |
| **揭示控件** | **`div.keyfield-value`**，文本形如「显示您的 Leartes Studios 密钥」；首页 20 个 |
| 它不是按钮 | 该元素**没有** `button` / `[role=button]`，靠 JS 事件处理器响应点击——**按 `button` 选择器找会 0 命中** |
| a11y 视角 | 在无障碍树里它被合并进单元格的可访问名字（`cell "显示您的 … 密钥 Redemption Instructions …"`），**不存在单独的 button 节点** |

### 订单专属页 `/downloads?key=<gamekey>`（揭示改为走这里）

`/download?key=<gamekey>` 会 302 到这里。**只列这一单的 key、没有分页**，比 48 页的密钥页可靠得多
（在 952 个 key 里认错控件 = 点到别的 key，不可逆）。

实测（`key=52YH6x4ubXAB5qwr`，77 个 keyfield 全部已揭示）：

| 项 | 实测结果 |
| --- | --- |
| 控件链 | `.key-redeemer > .container.js-third-party > .js-keyfield > .keyfield-value`；**全链没有 `<tr>`**（是 div 布局） |
| 已揭示 | `.keyfield-value` 文本 = 密钥本身；`.js-keyfield` 的 `title` 属性**也是密钥** |
| 未揭示 | 文本与 `title` 均为占位「显示您的 … 密钥」，`.js-keyfield` 带 `enabled`，内含 `.spinner-icon` |
| 行文本 | 含**资产显示名**（`Astronauts (Pack)`）＋码；**不含机器名**（`astronautspack_fab`） |
| 渲染时机 | 异步：打开后**要好几秒**才出现 `.keyfield-value`（立刻探测会拿到 0 个） |

> **点击后码出现在哪里**：对**已揭示**的 key 已确认落在 `.keyfield-value`（与 `title`）。
> 对**一次全新的揭示点击**仍未实测（那一步不可逆，尚未执行）。

## 揭示机制（当前：**全权交给 agent**）

`#27` 早期做的是「App 写死探针脚本 + 特征匹配 + 按坐标点击」，**已整体删除**
（`src/main/reveal/` 模块及其 50 条测试一起移除）。理由：那条路在同一天里被挖出**三个 bug，
每一个都让它静默失败成「交人工」**，而且不报错、不崩溃：

| # | bug | 后果 |
| --- | --- | --- |
| 1 | 探针脚本用 `el.closest('tr')`，而订单页是 div → 回退到「只有码」那层 | `rowText` 里没有资产名 |
| 2 | driver 把**机器名**当**显示名**传去匹配（`RevealInput` 里根本没有 `name`） | 即使修好 1 也匹配不上 |
| 3 | 不等页面渲染就探测（异步渲染要好几秒） | 控件还没出来就判死 |

现在：

| | 旧（已删） | 现 |
|---|---|---|
| 选控件 | App 写死的特征匹配（按资产名/机器名匹配行文本） | **agent 看 `monospace_dom` 自己判断** |
| 点击 | 代码按坐标点击（`clickAt`） | **agent 用 `monospace_act(click, uid)`** 点页面自己的控件 |
| 读码 | 页面优先、读不到用**接口**读 `redeemed_key_val` | **只从页面读**（agent 读 DOM 后写回） |
| 打开页面 | 打开 48 页的 `/home/keys` | **`monospace_key_open(keyId)`** 打开该单订单页 |
| 记账 | 代码走状态机 + `markRevealed` | agent 用 **`monospace_keys_upsert`** 写回（强制留痕） |
| 接口角色 | 兜底取码 | **只做核对与查缺口**（类型上就不带码，见 `CrossCheckState`） |

工具面变化：删 `monospace_key_reveal`（硬编码流程），新增 `monospace_key_open`（**只开页面、不点击**）。
UI 的「揭示」按钮改为**把任务交给 agent**（`agent:run` + 一段写死步骤的提示词），不再有代码兜底。

不可逆动作的纪律从代码挪到了提示词里：**只点一次**、认不出控件就交人工、**不重放点击**、
**不用接口取码**。这是这次改动的代价——原来那套状态机（`flow.ts`/`state.ts`）连同「resume 只重读不重放」
的强制约束一起删掉了，现在靠提示词和 agent 遵守。

> 仍未实测：**一次全新的揭示点击**（打开 → 点 → 读到码 → 写回）。这是唯一不可逆的一步，尚未执行。

## 兑换也改为代理驱动（2026-09-27 追加，ADR-0005）

与揭示同构的改动：**兑换**的代码驱动栈（`src/main/redeem/**`：状态机 / 错误码表 /
页面驱动 / 回执解析 / 库校验 / 命令通道 / 页面扩展 / 8 个测试）、只服务它的扩展基建
（`browser/bundled-extensions.ts`、`browser/extension-path.ts`、`electron-builder.yml` 的
`extraResources`）与 `tasks:redeem` 通道**已整体删除**。

现在：`monospace_key_open(keyId)` 打开订单页 → 必要时先揭示拿码 → 读那一行的
「Redemption Instructions」链接决定去哪家商店 → 用**页面自己的控件**填码、提交 →
从页面读出结果 → `monospace_key_redeem` **只登记结果**（写台账 + 强制留痕）。
`monospace_key_redeem` 因此从 L2 降到 **L1**（留在 L2 则 agent 根本用不上）。

保留：`tasks:login`（登录是**人**的动作）；`browser/extension-host.ts` 与
`tests/fixtures/extension-mv3*/**`（通用 MV3 能力，e2e 依赖）。
代价：判据从可复现代码变成模型判断；不可逆动作的纪律只能靠提示词与审计。

