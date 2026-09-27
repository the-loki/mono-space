# 验证 36：导出的出口（保存对话框落盘）

对应 `docs/verify/33-full-test.md` §0 的问题 1：**「导出 JSON / CSV」原来没有任何出口**。

## 0. 结论先行

- 原行为：主进程把台账编成文本（实测真库 499077 字符 JSON / 251423 字符 CSV）交给渲染层，
  渲染层只取 `text.length` 显示一句「已生成 JSON（499077 字符）」，**文本被丢掉** —— 全仓
  无 `showSaveDialog` / `clipboard` / 导出用途的 `writeFile`，点完按钮 `~/Downloads` 文件数不变。
  功能等于没做。
- 现行为：点按钮 → **弹原生保存对话框** → 选中/输入路径 → **真的写盘**，界面回显完整路径。
  真机实测（真库 1087 行 / 68 单）：JSON **538745 字节**、CSV **256787 字节**，权限 **600**。
- 顺带把一条尾巴收掉：`noCodeReason` **原来被刻意排除在导出外**，理由是「导出没有出口」（见
  `docs/verify/35` §6）。出口修好后这条理由消失，这一列**已纳入导出**（见 §4）。

## 1. 改法（为什么改语义而不是加通道）

`ledger:export` 全仓**只有那两个按钮**在用（`grep` 过，无其他调用方），所以直接把它的语义从
「返回文本」改成「弹对话框写盘」，**不新加一条没人用的通道**（那样才是死代码）。

```
src/main/ipc/export-file.ts   ← 新文件：选路径 / 写文件抽成注入依赖
  SaveExportDeps { pickPath, writeFile }        依赖注入，纯编排在这里
  defaultExportFileName(request, now)           文件名规则（纯函数）
  exportDialogTitle(request)                    对话框标题（跟着范围走）
  saveExportFile(deps, request, text, now)      取消 → {saved:false} 且不写；写失败往上抛
  createSaveDeps(env, showSaveDialog)           真实依赖 + MS_EXPORT_DIR 测试缝（§2）
  writePrivateFile                              mode 0o600（导出含兑换码明文）
```

几个刻意选择：

- **文件名带导出范围**：`monospace-order-<订单号>-<日期>.<ext>` / `monospace-ledger-<日期>.<ext>`。
  在明细视图只导一单，若与全量同名，存两次就分不清哪份是哪份。
- **取消不是错误**：`{saved:false}`，界面提示「已取消保存」，**什么都不写**。
- **写失败要抛**：界面显示「导出失败：<原因>」，不静默吞掉。
- **权限 600**：导出内容**含兑换码明文**（这正是导出的用途），不该让同机其他用户读到 ——
  与 `agent/config.ts` 写 `auth.json` 的做法一致。
- **日期用本地日历**（用户看到的是自己的日历，不是 UTC）。

## 2. 测试缝：`MS_EXPORT_DIR`（为什么必须有）

原生保存对话框**没法在无头环境里点**（这台机器连 `xdotool` / `wmctrl` / `xte` 都没有，
只有只读的 `xprop` / `xwininfo`）。没有缝的话：

1. 「导出真的落盘了吗」只能靠人手点一遍，**无法回归**；
2. e2e 永远覆盖不到这条链路（Playwright 驱动的是渲染进程，管不了原生对话框）。

所以加了 `MS_EXPORT_DIR`：**设了就不弹对话框、直接存到该目录**。这是仓库既有的做法
（`MS_LEDGER_DB` 覆盖库路径、`MS_TEST` 装测试钩子），不是新发明。

- 空串 / 纯空白 ⇒ 照旧弹对话框（有测试钉住「默认行为不被缝改掉」）。
- 缝里写文件仍走同一个 `writePrivateFile`（**权限 600 在两条路径上都成立**）。

## 3. 验证

| 层 | 内容 | 结果 |
| --- | --- | --- |
| 单测 | `src/main/ipc/__tests__/export-file.test.ts`：文件名规则 / 日期 / 标题；存盘写文件并回路径；**取消不写任何文件**；依赖收到默认文件名与标题；写失败上抛；0600；缝的三条（设了不弹、trim、没设照旧弹） | **12 条通过** |
| 单测（全仓） | `pnpm test:unit` | **364 通过 / 31 文件**；typecheck 0；lint 干净 |
| e2e | `tests/e2e/ledger.spec.ts` 新增「导出 JSON / CSV：真的落盘到指定目录」：点按钮 → 断言目录里**真有**文件、文件名符合 `monospace-ledger-<日期>.<ext>`、JSON 能 `JSON.parse`、嵌套 `orders[].bundles[].keys[]` 里**含码**、含 `noCodeReason`、CSV 表头含两列、界面提示给出路径；并断言**同一页面的列表里仍不含码明文** | `7 passed / 2 skipped`（2 例为手动用例） |
| 真机（缝路径） | 启动真应用（真库 68 单）→ 点「导出 JSON」/「导出 CSV」 | JSON **538745 字节**、CSV **256787 字节**，落在 `$MS_EXPORT_DIR`，`stat` 权限 **600**，界面提示「已保存到 /tmp/…/monospace-ledger-2026-09-27.json」 |
| 真机（缝路径·内容核对） | 用 **Python `csv`**（正确处理引号内逗号）解析导出的 CSV | 1087 行 × **16 列无错位**；`noCodeReason` 分布 `(空) 1002 / expired 55 / exhausted 17 / link_only 13` —— **与库内一致**；不变式「有码且有缘由」= **0** |
| 真机（无缝） | 启动真应用、**不设** `MS_EXPORT_DIR` → 点「导出 JSON」 | `_NET_CLIENT_LIST` 里新出现受管窗口 **`0x6c00969` 「导出全部台账」**（`WM_CLASS = xdg-desktop-portal-gtk`）——**原生对话框真的弹出**；此时界面提示**为空**（IPC promise 挂着等用户）；截图 `/tmp/verify-export/dialog-screen.png` 可见标题、预填文件名 `monospace-ledger-2026-09-27.json`、JSON 格式筛选、取消/保存按钮 |

**没验到什么**（说清边界）：对话框里「真按保存 / 真按取消」这一步**没有驱动**（无 xdotool）。
拆开的证据是：① 它确实弹出（窗口 + 截图）；② 存盘逻辑由 12 条单测覆盖（含取消不写、写失败上抛）；
③ 缝路径下**真的写出了文件**（内容/权限都核过）。也就是说唯一没被真机覆盖的是「portal 返回的路径
怎么交回主进程」这一跳，而它是 Electron 的 `showSaveDialog` 契约本身。

## 4. 顺带收掉的尾巴：`noCodeReason` 纳入导出

`docs/verify/35` §6 记过：「导出不带这一列，因为导出目前没有任何出口……等导出修好再加」。
导出修好了，就顺势纳入 —— 导出台账却不告诉你哪些行没有码、为什么没有，正是用户要这个功能的原因。

改动点与**老文件兼容**：

- `types.ts`：`LedgerKeyFieldName` 不再排除 `noCodeReason`；列名映射表加 `noCodeReason: 'noCodeReason'`。
  （那张映射表有 `satisfies` 编译期闸门 —— 「列表加了字段就逼导出加列」；本次闸门如实报出了两处漏加列。）
- `serialize.ts`：`CSV_OPTIONAL_COLUMNS` 变为 `['platform', 'noCodeReason']` —— **老导出文件没有这两列，
  缺了不算格式错误**（`platform` 缺省 unknown、`noCodeReason` 缺省「未判定」null）；CSV 行构造、
  `rowsToOrders`、`normalizeOrder` 三处都接上 `normalizeNoCodeReason` 收敛。
- `repository.ts`：导出 SQL 加 `k.no_code_reason`。
- **列顺序**：后加的列追加在末尾（现在是 `…, redeemCode, platform, noCodeReason`），
  归属列是历史顺序、永不挪动；测试从「末列是 platform」加强为「末两列是 platform/noCodeReason
  **且前 6 列是固定的归属列**」。
- 新测试：无码缘由在 **JSON / CSV 两个方向都能往返**（导出含 `noCodeReason` 与取值，导回来还在，
  有码的行不会凭空长出缘由）；老 JSON / 老 CSV（把末两列削掉）仍能导回。

## 5. 过程里我自己的仪器故障（备案）

三次，全是仪器不是产品 —— 但前两次都**先误判成了产品问题**：

1. **e2e 断言猜错导出结构**：我按 `parsed.keys` 取扁平数组，真实导出是 `orders[].bundles[].keys[]` 嵌套。
   测试如实报红（`Received array: []`），改断言后通过 —— 这是测试**帮**我发现断言写错了，
   也顺带发现 `noCodeReason` 当时根本不在导出里（§4 的起因）。
2. **`env "" DISPLAY=:0 cmd` 空第一参数**让应用启动直接失败 + `grep -c … || echo 0` 在无匹配时
   打印两行导致 `[ -gt ]` 报错 ⇒ 我一度得出「窗口树没变化、对话框可能没弹出」的假结论。
   换成 `_NET_CLIENT_LIST` + 截图后才拿到真结论（对话框弹了）。
3. **`awk -F,` 解析 CSV**：导出里含逗号的字段是带引号的（`"Blender & C# - $25 Tier"`），
   朴素按逗号切会让列错位 ⇒ 我一度看到「码出现在第 16 列」的假象。换 Python `csv` 后完全对齐。

教训：**看到红先分清是仪器还是产品**，尤其是「自己临时写的解析/计数」；能用仓库自己的解析器
或成熟库核对时，不要手搓分隔符切分。

## 6. 复现方式

```bash
# 单测（含 12 条导出用例）
pnpm test:unit

# e2e（含「导出真的落盘」那条）
pnpm test:e2e

# 真机：缝路径（直接落盘，可核对内容/权限）
MS_EXPORT_DIR=/tmp/exports pnpm build && MS_EXPORT_DIR=/tmp/exports electron . --no-sandbox
#   然后点「导出 JSON」「导出 CSV」，检查 /tmp/exports 下的文件

# 真机：无缝（看原生对话框）
electron . --no-sandbox   # 点「导出 JSON」，屏幕上应出现标题「导出全部台账」的保存对话框
```

本次驱动脚本（`/tmp/verify-export*.sh`）是临时脚本、**未入库**；上面三条命令是等价的最小复现。
