# 验证 #17：Electron 打包与脚手架组合能否落地

- 票据：the-loki/mono-space#17（wayfinder task，AFK）
- 验证日期：2026-09-26
- 环境：Ubuntu 26.04.1（kernel `7.0.0-34-generic`），Node `v24.20.0`，pnpm `10.17.1`（另测 corepack pnpm `11.0.0`），`electron@44.4.5`（Chrome `152.0.7977.130` / Node `24.21.0`），`electron-vite@5.0.0` + `vite@7.3.6`，`electron-builder@26.16.1`
- 临时工程：`/tmp/ms-spike-17`（结论与原始输出见下）
- 说明：本报告由子代理跑出原始数据、主代理复核补全（子代理在写报告前请求超时终止，原始日志保留在临时工程）

---

## 0. 结论总表

| # | 待验项 | 结论 |
|---|---|---|
| 1 | ESM 主进程 + sandboxed preload 共存 | **成立** |
| 2 | pnpm 打包坑（#10228 / #9025） | **有条件成立**（pnpm 10 未复现；pnpm 11 直接跑不通 build，需配置） |
| 3 | Ubuntu 24.04+ AppArmor userns：.deb / AppImage 能否装完即启动 | **有条件成立**（AppImage 实测启动；deb 依赖 postinst 装入 AppArmor profile，未做 root 安装实测） |
| 4 | 内置 Node ≥ 22.19（决定进程内 SDK 可行） | **成立**（24.21.0） |

---

## 1. 「ESM 主进程 + sandboxed preload」共存 —— **成立**

**配置**（`/tmp/ms-spike-17/esm-sandbox`，全部生效）：

```jsonc
// package.json
{ "type": "module", "main": "./out/main/index.js" }
```

```ts
// electron.vite.config.ts
export default defineConfig({
  main: {},
  preload: {
    build: {
      isolatedEntries: true,
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } }
    }
  },
  renderer: {}
})
```

主进程创建窗口时 `webPreferences: { preload, sandbox: true }`（contextIsolation 走默认 true）。

**原始输出**（`run-esm-sandbox.log`）：

```
[MAIN] process.versions.node = 24.21.0
[MAIN] process.versions.electron = 44.4.5
[MAIN] typeof require = undefined (undefined => real ESM)
[MAIN] import.meta.url = file:///tmp/ms-spike-17/esm-sandbox/out/main/index.js
[MAIN] effective sandbox = true
[MAIN] effective contextIsolation = true
[MAIN] preload introspection: {
  "fileIsCjs": true,            ← 产物是 .cjs
  "sandboxed": true,            ← 真的在 sandbox 下
  "typeofRequire": "function",  ← sandbox preload 的受限 require
  "processType": "renderer",
  "nodeOs": "BLOCKED: module not found: node:os"   ← Node 内建被挡，证明确实 sandbox
}
[MAIN] ipcMain.handle spike:ping received: "tagged<hello-from-renderer>"
[MAIN] renderer reported result: {"out":"pong:...","typeofWindowApi":"object","typeofWindowProcess":"undefined","typeofWindowRequire":"undefined"}
[MAIN] RESULT: ESM main + sandboxed CJS preload WORKS
```

**要点**：
- 主进程是真 ESM（`require === undefined`，`import.meta.url` 可用）。
- preload 以 **`.cjs`** 输出、`isolatedEntries: true` + `externalizeDeps: false`，在 `sandbox: true` 下**能加载并完成 `contextBridge` 往返**。
- 渲染进程侧 `window.require` / `window.process` 均为 `undefined`，只暴露 `window.api`。

→ 选型报告 §8 第 1 项的纸面方案**可照走**（preload 输出 `cjs`、`isolatedEntries`、`externalizeDeps:false` 三条缺一不可）。

---

## 2. pnpm 打包坑 —— **有条件成立**

### 2.1 pnpm 10.17.1 + `shamefully-hoist=true`（选型报告的钉法）：**#10228 / #9025 未复现**

构造：root 直接依赖 `debug@4.4.3`，同时依赖 `compression@1.7.5`（其内部需要 `debug@2.6.9`）。打 `--linux dir` 出 `linux-unpacked/resources/app.asar` 后运行探测：

```
SPIKE_JSON {
  "packaged": true,
  "rootDebug": "4.4.3",
  "nestedDebugPath": ".../app.asar/node_modules/compression/node_modules/debug/package.json",
  "nestedDebug": "2.6.9",
  "debugAsSeenByCompression": {
    "resolved": ".../app.asar/node_modules/compression/node_modules/debug/src/index.js",
    "version": "2.6.9"     ← compression 拿到的仍是 2.6.9，未被 root 的 4.4.3 覆盖
  }
}
```

AppImage 内同样保留嵌套版本（`.../resources/app.asar/node_modules/compression/node_modules/debug` = 2.6.9）。→ **#10228（嵌套版本被 root 覆盖）与 #9025（symlink 拷贝失败）在「单包 + shamefully-hoist + electron-builder 26.16.1 + pnpm 10」下未复现。**

### 2.2 pnpm 11.0.0 + `node-linker=hoisted`：**跑不通 `electron-builder`，需先配置**

```
$ corepack pnpm@11.0.0 exec electron-builder --linux dir
Lockfile is up to date, resolution step is skipped
Already up to date
 ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: electron-winstaller@5.4.0
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
 ERROR  Command failed with exit code 1: .../pnpm.mjs install
    at runDepsStatusCheck (.../pnpm.mjs)
```

**原因**：pnpm 11 在 `pnpm exec`（run scripts）前新增 **deps status check**，会重新跑 `pnpm install`；而 pnpm 11 默认**忽略依赖的 build script**（新的安全默认），于是 `install` 以 `ERR_PNPM_IGNORED_BUILDS` 失败，整个 build 被阻断。

**结论 / 处置**：本项目**钉 pnpm 10.x**（选型报告写的是「pnpm 10/11」，未钉死；建议钉 `10.17.1`）。若将来必须上 pnpm 11，需要 `pnpm approve-builds` 或 `onlyBuiltDependencies: [electron, electron-winstaller, ...]`，或绕开 deps 检查执行 build。

### 2.3 附带发现：deb 构建需要 `homepage`

```
⨯ Please specify project homepage, see https://www.electron.build/configuration#metadata
   at FpmTarget.computeFpmMetaInfoOptions
```

electron-builder 26.16.1 在**打 deb** 时强制要求 `package.json` 有 `homepage`（AppImage 不要求）。补齐 `homepage` / `author` / `desktopName` 后，AppImage 与 deb 均成功产出：

```
PackSpike-0.1.0.AppImage      125 MB
pack-spike_0.1.0_amd64.deb     99 MB
```

（未补时 AppImage 已成功、deb 失败——说明这是 **deb/rpm 专属**的前置要求，需在脚手架模板里预置。）

---

## 3. Ubuntu 24.04+ AppArmor userns：装完能否启动 —— **有条件成立**

### 3.1 环境实际状态

```
kernel.apparmor_restrict_unprivileged_userns = 1     ← 限制开启
kernel.unprivileged_userns_clone = 1

unshare --user true   → OK                        ← 注意：不带 -r 时成功
unshare -Ur true      → FAIL: 写失败 /proc/self/uid_map: 不允许操作   ← Chrome/AppRun 用的正是带 -r 的探测
```

即：**AppArmor 限制了「映射 root 的」用户命名空间**——`unshare -Ur true` 失败，而 `unshare --user true`（不映射）成功。Chrome 的 userns sandbox 需要后者那种映射，因此**裸启动会失败**。

### 3.2 AppImage：**实测可启动**

AppImage 的 `AppRun` 内置探测（官方 runtime）：

```bash
if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then
  NO_SANDBOX=(--no-sandbox)
fi
...
exec "$BIN" "${NO_SANDBOX[@]}" "${args[@]}"
```

因 `unshare -Ur true` 本机失败，AppRun **自动追加 `--no-sandbox`**。实测：

```
$ DISPLAY=:198 APPIMAGE_EXTRACT_AND_RUN=1 ./PackSpike-0.1.0.AppImage
SPIKE_JSON { "node":"24.21.0", "electron":"44.4.5", ..., argv: [...,"--no-sandbox"] }   ← 启动成功
```

对照：从 AppImage 解出的裸二进制**不加** `--no-sandbox` 则中止：

```
FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166
The SUID sandbox helper binary was found, but is not configured correctly.
... make sure that .../chrome-sandbox is owned by root and has mode 4755.
```

→ **AppImage 在 Ubuntu 24+「装完即启动」成立**，代价是**牺牲 Chromium 沙箱**（AppRun 自动降级 `--no-sandbox`）。AppImage 内 `chrome-sandbox` 为 `0755`（非 4755）。

### 3.3 .deb：**有条件成立**（依赖 postinst 装入 AppArmor profile）

deb 内 `resources/apparmor-profile`：

```
abi <abi/4.0>,
profile "pack-spike" "/opt/PackSpike/pack-spike" flags=(unconfined) {
  userns,
  include if exists <local/pack-spike>
}
```

postinst 逻辑（electron-builder 26.16.1 生成）：

```bash
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/PackSpike/chrome-sandbox' || true
else
    chmod 0755 '/opt/PackSpike/chrome-sandbox' || true
fi
# 若 apparmor_parser 支持 abi/4.0，则把 apparmor-profile 装到 /etc/apparmor.d/ 并加载
```

**判定**：
- 在 Ubuntu 24+，postinst 会**装入上面这份 profile**，其 `userns,` 恰好放行本机被 AppArmor 挡掉的那类用户命名空间 → **应用能带沙箱正常启动**。
- **潜在坑**：postinst 的探测用的是 `unshare --user true`（**不带 `-r`**），本机它**成功**，于是 chrome-sandbox 被设成 `0755`（非 SUID）。若某系统上 AppArmor profile **未能装入**（老 apparmor / 无 apparmor_parser），则既没有 SUID、`-Ur` 又被挡 → 可能启动失败。这是上游启发式的一个**假阳性**，但在 Ubuntu 24+ 的默认组合下被 profile 兜住。
- **验证边界**：本机**无 root/sudo**，未做真正的 `dpkg -i` 端到端安装；结论由「profile 内容 + postinst 逻辑 + userns 实测」推出，属**有条件成立**。实现期若有 root，应补一次真实 `dpkg -i` + 启动验证。

### 3.4 对本项目的直接含义

- **AppImage 是主分发形态**（选型报告即如此定）：零安装、自动规避沙箱限制，代价是运行期无 Chromium 沙箱。
- 这与 ADR-0001 的**安全叙事不冲突但要写清**：应用本就以「用户手动登录一次、复用会话」运行，且 `persist:` 分区在无密钥环时就是 `basic_text`；再叠一个「无 Chromium 沙箱」是同一量级的清醒取舍，应在 v1 里显式告知（呼应 #10）。
- 若要保住沙箱：走 deb（依赖 AppArmor profile），或给 AppImage 配对应 AppArmor/SUID（复杂度不值，自用场景不做）。

---

## 4. 内置 Node ≥ 22.19 —— **成立**

```
[MAIN] process.versions.node = 24.21.0
[MAIN] process.versions.chrome = 152.0.7977.130
[MAIN] process.versions.electron = 44.4.5
```

Electron 44.4.5 内置 Node **24.21.0 ≥ 22.19** → **#4 的「进程内 SDK（`createAgentSession`）」可行**，无需退回子进程方案。打包态同样为 24.21.0（见 §3.2 `SPIKE_JSON`）。

---

## 5. 回灌 #14（v1 切片与实现顺序）

1. **脚手架可照选型报告走**：electron-vite 5 + Vite 7.3.6 + Electron 44.4.5；主进程 ESM + `/type: module`，preload 输出 **`.cjs`** + `isolatedEntries:true` + `externalizeDeps:false` + `sandbox:true`（§1）。
2. **钉 `pnpm@10.17.1`**（或至少不用 pnpm 11 的默认 build-script 策略）；`.npmrc` 用 `shamefully-hoist=true`；#10228/#9025 在本结构未复现（§2.1、§2.2）。
3. **脚手架模板预置 `package.json` 的 `homepage` / `author` / `desktopName`**，否则 deb 打不出来（§2.3）。
4. **主分发 = AppImage**；文档里明确「AppImage 在 Ubuntu 24+ 会自动以 `--no-sandbox` 运行」；deb 作为可选（依赖 AppArmor profile）（§3）。
5. 内置 Node 24.21.0 满足进程内 SDK，**#4 的结论可保留**（§4）。

---

## 6. 原始证据索引（临时工程 `/tmp/ms-spike-17`）

| 文件 | 内容 |
|---|---|
| `esm-sandbox/electron.vite.config.ts`、`esm-sandbox/package.json` | §1 配置 |
| `run-esm-sandbox.log` | §1 运行输出 |
| `pack/`（pnpm 10 + shamefully-hoist）、`pack-hoisted/` | §2 工程 |
| `run-pack-unpackaged.log`、`run-pack-dir.log`、`run-appimage.log` | §2 嵌套版本探测 |
| `build-dir.log`、`build-linux.log` | §2.3 homepage 报错 + AppImage/deb 产出 |
| `pnpm11test/` | §2.2 pnpm 11 失败复现 |
| `deb-control/postinst`、`deb-extract/opt/PackSpike/resources/apparmor-profile` | §3.3 |
| AppImage `AppRun`（`/tmp/ai-extract/squashfs-root/AppRun`） | §3.2 自动 `--no-sandbox` |
