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

## 2. 只能在真实登录下完成（HITL，未执行）

以下需要**真实 Epic / Humble 账号**，故不在本次自动验收范围内。这是 `#14` §7 的
「首次登录 checklist」，也是 `#12`/`#16`/`#18`/`#22`/`#25`/`#26` 的残差汇聚点。

### 2.1 首次运行引导

- [ ] 内嵌窗口登录 **Humble**（登录态落在 `persist:store` 分区）。
- [ ] 内嵌窗口登录 **Epic**。
- [ ] 首次同步跑通（点台账页「同步」），确认 `SyncReport` 计数合理。
- [ ] 主界面显示台账。

### 2.2 残差回填（每条都要把实测结果写回对应文档）

| 残差 | 来源 | 回填到 |
| --- | --- | --- |
| Fab profile → **Redeem Code 的确切 href** | `#12` | `docs/spec/12-fab-redemption-flow.md` |
| Epic 账号兑换页**实际渲染文案 vs `#18` 错误码**的对照 | `#12`/`#18` | `docs/verify/18-epic-redemption-errors.md` |
| 登录态下 `/i/users/me` 返回 **200**、一次真实 claim **全程无 challenge** | `#16` | `docs/verify/16-embedded-browser.md` |
| Epic **2FA 的实际方法**与「约 30 天重索」的实测 | `#18` | `docs/verify/18-epic-redemption-errors.md` |
| Humble 订单列表**是否真的无服务端分页**、真实库耗时/内存 | `#22` | `docs/research/humble-reveal.md` |
| 揭示控件定位（已实测，见下节）| `#25` | `src/main/reveal/page-reader.ts` |
| Epic 兑换页 DOM 选择器校准 | `#26` | `src/main/redeem/extension/README.md` |

### 2.3 端到端

- [ ] 单条**揭示**成功（Humble）：状态 `unrevealed → revealed`，台账出现「已揭示未兑换」。
- [ ] 单条**兑换**成功（Fab）：My Library 校验通过，状态变「已兑换」。
- [ ] 未知错误码 → `needs_human`（真实页面下复现一次）。
- [ ] 会话失效 → 中止整批、重登后重跑。

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

## 实测校准：密钥页真实 DOM（2026-09-26，已登录真实账号）

用 MonoSpace 自带的浏览器能力（`evaluate_script` 只读探测 + a11y 快照）在真实
`https://www.humblebundle.com/home/keys` 上核对出的结构：

| 项 | 实测结果 |
| --- | --- |
| 密钥表 | `table > tr`，表头为 `th.platform` / `th.game-name` / `th.redeemer-cell`；**首页 21 行** |
| **揭示控件** | **`div.keyfield-value`**，文本形如「显示您的 Leartes Studios 密钥」「显示您的 Fab 密钥」；**首页 20 个** |
| 它不是按钮 | 该元素**没有** `button` / `[role=button]`，靠 JS 事件处理器响应点击——**按 `button` 选择器找会 0 命中**，这是之前揭示驱动选不中的根因 |
| a11y 视角 | 在无障碍树里它被合并进单元格的可访问名字里（`cell "显示您的 … 密钥 Redemption Instructions 兑换截止时间是 …"`），**单独一行的 `button` 节点并不存在** |

**因此揭示驱动应当**：定位 `tr` 里 `div.keyfield-value`（文本以「显示您的」开头）
→ 取其矩形中心点击（真实 CDP 输入事件），**不要**依赖 `button` 选择器。

> 仍未实测（用户要求先不点真 key）：**点击后码出现在页面哪个元素里**、分页推进方式（首页标注 48 页）。
> 因此 `extractKeyCode` 采用宽松匹配 + **接口兜底**（读不到就用只读 GET 的 `redeemed_key_val`）；
> 定位不到控件时**交人工，绝不猜着点**（不可逆操作宁可失败）。

### 揭示机制（`#27` 用户决策：默认走浏览器，接口兜底）

| | 旧（已删） | 现 |
|---|---|---|
| 触发揭示 | 扩展在同源上下文 `POST /humbler/redeemkey` | **CDP 真实输入事件点页面自己的揭示控件** `div.keyfield-value` |
| 读码 | 解析 POST 响应；silent-no-key 时重 GET 订单 | **优先从页面读**；读不到 → **接口兜底**（只读 GET 的 `redeemed_key_val`） |
| 扩展 | 必需（绕 TLS 指纹） | **不再需要**，揭示扩展已删除（`MonoSpace Humble helper` 随之消失） |
| 只读前置校验 | API 判 `redeemed_key_val` | 页面优先（控件文案），API 兜底 |
| 定位失败 | — | **交人工**，不猜着点 |

