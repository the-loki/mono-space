# Electron + React + Zustand + Tailwind CSS 4 + Biome + pnpm：脚手架与构建链选型

- 研究票据：mono-space #5
- 验证日期：**2026-09-26**
- 目标平台：**Linux（仅 Linux）**；macOS 相关内容已在第 6 节压成一两行说明「不适用」。
- 版本基准：全部以 2026-09-26 当天 `npm view <pkg> version` / `dist-tags` 与官方文档（electron-vite.org、tailwindcss.com、biomejs.dev、electron.build、electronjs.org、electronforge.io）为准。

---

## 0. 结论先行（TL;DR）

**选用 electron-vite（稳定线），配 Vite 7，单包结构起步；Tailwind 4 走 `@tailwindcss/vite` + CSS-first；Biome 2.5 做 lint+format、`tsc --noEmit` 单独做类型检查；Zustand 只放渲染进程 UI 状态，持久化走「主进程文件 + IPC 自定义 storage」；分发用 electron-builder，Linux 出 AppImage + deb/rpm。**

| 决策点 | 推荐 | 版本 | 关键理由 |
|---|---|---|---|
| 构建器 | **electron-vite** | `electron-vite@5.0.0` + `vite@7.3.6` | 官方模板含 main/preload/renderer 三份构建、渲染进程 HMR、主进程/preload 热重载；稳定线 peer 只到 Vite 7 |
| 不选 | electron-forge（Vite 模板） | `@electron-forge/cli@7.11.2` | 无官方 AppImage maker、`plugin-vite` 热重启默认关闭、pnpm workspace 支持仍是 open issue；打包链更「重」 |
| 不选 | 手搭 Vite + Electron | `vite-plugin-electron` | 三套构建要自己拼，收益不明确 |
| 样式 | `@tailwindcss/vite` + CSS-first | `tailwindcss@4.3.3` | 无需 `tailwind.config.js`；vite 插件 peer 覆盖 Vite 5.2–8 |
| Lint/Format | **Biome** | `@biomejs/biome@2.5.14` | 单二进制、JS/TS/JSX/JSON/CSS/GraphQL 全覆盖；多环境用 `overrides` + `files.includes` |
| 类型检查 | `tsc --noEmit`（独立） | `typescript@5.9.3` | Biome 不做类型检查，二者分工不重叠 |
| 状态 | Zustand（渲染进程） | `zustand@5.0.15` | 主进程持真源，渲染进程持 UI 状态；`persist` 用主进程文件后端 |
| 打包 | electron-builder | `electron-builder@26.16.1` | Linux 默认 target = AppImage；deb/rpm/snap/flatpak/tar.gz 齐全 |
| 包管理 | pnpm + `.npmrc: shamefully-hoist=true` | pnpm 10/11 | electron-vite 官方故障排查明确要求；规避 electron-builder 的 symlink 收集问题 |

> **最重要的版本红线**：`electron-vite@5.0.0` 的 peerDependencies 是 `vite: ^5 || ^6 || ^7`，**不支持 Vite 8**。而 npm `vite@latest` 已经是 `8.3.1`。若想用 Vite 8，必须上 `electron-vite@6.0.0-beta.1`（peer 为 `^6 || ^7 || ^8`），那是 beta。因此稳定组合是 **electron-vite 5 + Vite 7.3.6**。

---

## 1. 版本核对（verified 2026-09-26，来源 npm registry）

| 包 | npm `latest` | 备注 |
|---|---|---|
| `electron` | **44.4.5** | 引擎要求 Node `>=22.12.0` |
| `electron-vite` | **5.0.0** | dist-tags：`latest=5.0.0`、`beta=6.0.0-beta.1` |
| `vite` | **8.3.1** | dist-tags：`latest=8.3.1`、`previous=7.3.6` |
| `@vitejs/plugin-react` | **6.1.1** | 6.x 仅 peer `vite: ^8.0.0`（还需 oxc/rolldown 相关包） |
| `tailwindcss` | **4.3.3** | `v4-lts` 标签指向 3.4.19 |
| `@tailwindcss/vite` | **4.3.3** | peer `vite: ^5.2.0 \|\| ^6 \|\| ^7 \|\| ^8` |
| `@biomejs/biome` | **2.5.14** | engines `node >=14.21.3` |
| `zustand` | **5.0.15** | peer `react >=18.0.0` |
| `react` / `react-dom` | **19.3.0** | |
| `typescript` | **7.0.2** | 另有 `6.0.3`；官方 electron-vite 模板仍钉 `^5.9.3` |
| `electron-builder` | **26.15.3**（`latest` 标签） | **`v26` 标签 = 26.16.1**（更新）；`next = 27.0.0-alpha.8` |
| `@electron-forge/cli` | **7.11.2** | `alpha = 8.0.0-alpha.10` |
| `@electron-toolkit/preload` | 3.0.2 | electron-vite 模板内置 |
| `@electron-toolkit/utils` | 4.0.0 | 同上 |
| `@electron-toolkit/tsconfig` | 2.0.0 | 同上 |
| `@types/node` | 26.6.3 | 存在 24.19.0 / 22.20.4，应与运行时 Node 主版本对齐 |
| `electron-store` | 11.0.2 | ESM-only（`node >=20`），主进程侧备选 |

**兼容矩阵（已验证的 peerDependencies）：**

```
electron-vite@5.0.0        → vite ^5 || ^6 || ^7        （不含 8）
electron-vite@6.0.0-beta.1 → vite ^6 || ^7 || ^8
@vitejs/plugin-react@5.1.1 → vite ^4.2 || ^5 || ^6 || ^7 （配 Vite 7）
@vitejs/plugin-react@6.1.1 → vite ^8.0.0 only            （配 Vite 8）
@tailwindcss/vite@4.3.3    → vite ^5.2 || ^6 || ^7 || ^8
```

electron-vite 的 engines 为 `node: ^20.19.0 || >=22.12.0`。本机 Node 为 v24.20.0，满足。

---

## 2. 构建器选型

### 2.1 electron-vite（推荐）

- 版本：`5.0.0`（2025-12-07 发布）；`6.0.0-beta.1`（2026-04-12，改用 Vite 8）。
- 零配置约定入口：`src/main/{index|main}.ts`、`src/preload/{index|preload}.ts`、`src/renderer/index.html`；产物默认 `out/main`、`out/preload`、`out/renderer`。（来源：electron-vite-docs `guide/dev.md`）
- **HMR 体验**：渲染进程走 Vite HMR；主进程与 preload 走 Rollup watcher 触发的 **hot reload（自动重建并重启 Electron）**，仅开发环境生效。（来源：`guide/hmr-and-hot-reloading.md`）
- **主进程 ESM**：Electron 28+ 支持 ESM。electron-vite **默认输出 CJS**，ESM 是显式开启：
  1. 最近的 `package.json` 加 `"type": "module"`，或
  2. `electron.vite.config.ts` 里设 `build.rollupOptions.output.format: 'es'`。
  限制（官方原文）：preload 用 ESM 时**必须 unsandboxed 且文件名以 `.mjs` 结尾**。因此「ESM preload」和「`sandbox: true`」二选一。（来源：`guide/dev.md` §ESM Support in Electron）
- **preload 打包**：默认把 `package.json` 的 `dependencies` 视为 external，不打进 preload；sandbox 模式下要求单文件，需 `preload.build.isolatedEntries: true` + `build.externalizeDeps: false`（v5 起用 `build.externalizeDeps` 取代旧的 `externalizeDepsPlugin`）。否则会出现 `Unable to load preload scripts -> Error: module not found`。（来源：`guide/isolated-build.md`、`guide/dependency-handling.md`、`guide/troubleshooting.md`）
- **CSP 与安全默认值**：
  - Electron 自身默认值（自 Electron 5/20 起）：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`（来源：electron `docs/breaking-changes.md`、`docs/api/structures/web-preferences.md`、`docs/tutorial/sandbox.md`）。
  - electron-vite **不支持 `nodeIntegration`**，官方建议只用 preload + contextBridge（来源：`guide/dev.md` §nodeIntegration）。
  - 官方 react-ts 模板的 `webPreferences` 只写 `{ preload, sandbox: false }`（contextIsolation/nodeIntegration 走默认），即模板为了 preload 能用 Node 依赖**主动关掉了 sandbox**；若想保留 sandbox，按上面 isolatedEntries 方案做。
  - 模板 `src/renderer/index.html` 自带 CSP：
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`
    （来源：quick-start 仓库 `template/react-ts/src/renderer/index.html`）
  - 开发态 HMR 需要给 CSP 放行 `connect-src` 到 Vite dev server（`ws:`/`http://localhost:*`），生产构建要收紧。**具体 dev CSP 组合需实测**（见第 8 节）。
- **打包集成**：官方模板直接配 `electron-builder.yml`，`scripts` 里 `electron-vite build && electron-builder --linux`。

### 2.2 electron-forge（Vite 模板）

- 版本：`@electron-forge/cli@7.11.2`。脚手架：`npx create-electron-app@latest my-app --template=vite-typescript`。
- 结构：`@electron-forge/plugin-vite` 的 `build[]`（main/preload…）+ `renderer[]`；`forge.config.js` 用 `makers[]` 出包。
- 与 electron-vite 的差异（已验证）：
  - **主进程热重启默认关闭**：需要显式 `hotRestart: true`，否则改主进程后要手按 `rs`。
  - 模板主进程入口用 `__dirname` / `path.join(__dirname,'preload.js')`，**默认 CJS 产物**。
  - **没有官方 AppImage maker**：官方 maker 为 `maker-deb`、`maker-rpm`、`maker-zip`、`maker-flatpak`、`maker-snap`（均 7.11.2，npm 已核）；AppImage 依赖第三方 `electron-forge-maker-appimage`（electron-builder v27 文档提到它已转 ESM）。electron-builder 自带 AppImage target，forge 这边不是。
  - 已知 open issue：#4188「Support pnpm workspace」（2026-03-24）、#4350「plugin-vite does not declare vite as a runtime dependency」（2026-08-25）。

### 2.3 手搭 Vite + Electron

- 社区方案 `vite-plugin-electron`（ctx7 收录，源码片段多、评分高），本质是自己串 main/preload/renderer 三份 Vite 配置。
- 相对 electron-vite：没有零配置入口约定、没有官方模板/工具包（`@electron-toolkit/*`）、依赖处理的默认策略要自己定。**除非要接入 electron-vite 不支持的特殊构建（如自定义 rolldown 管线），否则不建议**。

### 2.4 三方案对比

| 维度 | electron-vite 5 | electron-forge 7（Vite） | 手搭 |
|---|---|---|---|
| 主进程 ESM | 支持（显式开启） | 支持（需自行配 Vite） | 自行 |
| 渲染进程 HMR | ✅ 开箱 | ✅ | 自行 |
| 主进程/preload 热重载 | ✅ 默认开 | ⚠️ 需 `hotRestart: true` | 自行 |
| preload 打包 | 默认 external，sandbox 需 isolatedEntries | 由 Vite lib build 决定 | 自行 |
| CSP/nodeIntegration 默认 | 模板给 CSP；不支持 nodeIntegration | 模板给 `sandbox` 默认，CSP 自备 | 自行 |
| Linux AppImage | ✅（builder） | ❌ 官方无 maker | 自行 |
| pnpm workspace | ✅（配 shamefully-hoist） | ⚠️ open issue | 自行 |
| 结论 | **选它** | 次选 | 不建议 |

---

## 3. Tailwind CSS 4 接入

### 3.1 安装与用法（v4.3.3）

```bash
pnpm add -D tailwindcss @tailwindcss/vite
```

```ts
// electron.vite.config.ts（只在 renderer 段加插件）
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  renderer: { plugins: [react(), tailwindcss()] }
})
```

```css
/* src/renderer/src/assets/main.css —— CSS-first 配置 */
@import "tailwindcss";

@theme {
  --color-brand-500: oklch(0.7 0.15 250);
  --font-display: "Inter", sans-serif;
}
```

（来源：tailwindcss.com `docs/installation/*`、`docs/theme`、`docs/functions-and-directives`）

### 3.2 是否还需要 `tailwind.config.js`

**不需要。** v4 是 CSS-first：主题写在 `@theme`，工具类/变体用 `@utility`/`@custom-variant`。官方把 `tailwind.config.js` 归为 **v3 兼容路径**，只有需要沿用旧 JS 配置时才用 `@config "../../tailwind.config.js"`；且 `corePlugins`/`safelist`/`separator` 在 v4 **不再支持**（safelist 改用 `@source inline(...)`）。（来源：tailwindcss.com `docs/functions-and-directives` §@config）

### 3.3 内容扫描（Electron / monorepo 的关键坑）

- v4 **默认自动扫描**整个「项目」，但排除：`.gitignore` 中的文件、`node_modules`、二进制文件、CSS 文件、常见 lockfile。
- **基准路径 = 当前工作目录（CWD）**，不是 CSS 文件所在目录。原文："Tailwind uses the current working directory as its starting point when scanning for class names by default."
- 因此：
  - 单包结构下从包根跑 `electron-vite`，CWD 正确，渲染进程源码能被扫到。
  - **pnpm workspace** 里 build 常从 monorepo 根跑，此时必须显式设基准：
    `@import "tailwindcss" source("../src/renderer/src");`
  - 共享 UI 包若位于 `node_modules`（workspace 软链）或被 `.gitignore` 忽略，需要 `@source "../node_modules/@your/ui-lib";`
  - 可 `@source not "..."` 排除目录，或 `source(none)` 完全手动登记。
  （来源：tailwindcss.com `docs/detecting-classes-in-source-files`）

### 3.4 Electron 渲染进程里的额外注意点

1. **动态类名不生成**：`text-${color}-600` 这类拼接无效，必须写完整类名或映射表。
2. **CSP**：官方 electron-vite 模板的 CSP 已含 `style-src 'self' 'unsafe-inline'`；开发态 Vite 以注入 `<style>` 的方式上样式/HMR，所以这一条是必须的。生产构建产物是独立 CSS 文件，理论上可去掉 `'unsafe-inline'`——**需实测**。
3. **base 路径**：见 3.3，monorepo 下用 `source()` 修正。
4. Tailwind 只在渲染进程生效；主进程/preload 不涉及样式，无需该插件。

---

## 4. Biome 接入

版本基准：`@biomejs/biome@2.5.14`。

### 4.1 相对 ESLint + Prettier 的完整度与缺口

**已覆盖（官方）**：JS/TS/JSX/TSX/JSON/JSONC/CSS/GraphQL 的解析、格式化、lint 均为 ✅；规则来源涵盖 ESLint core、`typescript-eslint`、`eslint-plugin-react`、`eslint-plugin-jsx-a11y`、`eslint-plugin-unicorn`（有专门的 ESLint→Biome 规则映射页）；GritQL 插件。Biome 2 引入 **domains**（按技术栈分组规则，检测到依赖会自动启用，如 `react`、`test`、`next`、`solid`、`project`、`types`、`tailwind` 等）。

**缺口/局限（官方明确写出）**：
- **无类型检查**：Biome 的 lint 本身不做 `tsc` 那种全量类型检查（`noFloatingPromises` 是 type-aware 的「概念验证」，不能理解复杂类型、不能类型推断、只能分析同文件内的类型）。
- **Markdown / YAML**：解析与格式化仍是「In Progress」，lint 不支持。
- **HTML**：解析 ✅，lint ✅，但 **格式化是 experimental 且要显式 opt-in**；Vue/Svelte/Astro 也是 experimental（v2.3 起）。
- **SCSS**：解析/格式化 In Progress，lint 不支持。
- 因此 **Prettier 覆盖的 Markdown/YAML 格式化在 Biome 里没有对等物**；本项目若只有 TS/TSX/CSS，缺口基本不影响。

（来源：biomejs.dev `internals/language-support`、`linter/index`、`linter/domains`、`blog/biome-v2-0-beta`、`guides/migrate-eslint-prettier`）

### 4.2 与 TypeScript 检查的分工

Biome 只管 **lint + format**，类型错误交给 `tsc --noEmit`。electron-vite 官方模板本来就是两套 tsconfig（`tsconfig.node.json` 管 main/preload + `electron.vite.config.*`，`tsconfig.web.json` 管 renderer + `src/preload/*.d.ts`），脚本里：

```json
"typecheck:node": "tsc --noEmit -p tsconfig.node.json --composite false",
"typecheck:web":  "tsc --noEmit -p tsconfig.web.json --composite false",
"typecheck": "pnpm typecheck:node && pnpm typecheck:web"
```

### 4.3 覆盖 main / preload / renderer 三类环境

两种等价做法，官方都支持：

1. **单文件 + `overrides`**（推荐，配置集中）：
   - 全局 `files.includes` 先圈定参与的所有文件；文件没进 `files.includes` 的话，任何工具级 `includes` 都无法再匹配它（官方 caution）。
   - `overrides[].includes` + `overrides[].linter.rules` / `overrides[].javascript.globals` 做环境差异化（如 main/preload 补 Node 全局，renderer 开 React domain）。
2. **嵌套 `biome.json`**（v2 起支持 monorepo）：子目录放 `biome.json` 且 `"root": false`，用 `"extends": "//"` 继承根配置。Biome 按「当前工作目录向上找最近的配置文件」解析。

**Tailwind 4 的必配项**：Biome 的 CSS 解析器默认不认识 Tailwind 指令，需要打开

```jsonc
"css": { "parser": { "tailwindDirectives": true } }   // 默认 false
```

否则 `@theme`/`@utility`/`@apply` 会被判为未知 at-rule。（来源：biomejs.dev `reference/configuration` §css.parser.tailwindDirectives）另有 `linter.domains.tailwind`（检测到 `tailwindcss>=3` 自动启用），但其规则目前**全是 nursery**，默认 `recommended` 不会启用任何规则。

**示例 `biome.json`：**

```jsonc
{
  "$schema": "https://biomejs.dev/schemas/2.5.14/schema.json",
  "root": true,
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "includes": [
      "src/**/*.{ts,tsx,js,jsx,json,css}",
      "electron.vite.config.ts",
      "!out/**",
      "!dist/**",
      "!**/*.d.ts"
    ]
  },
  "formatter": { "enabled": true, "indentStyle": "space", "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true },
    "domains": { "react": "recommended" }
  },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "asNeeded" } },
  "css": { "parser": { "tailwindDirectives": true } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "overrides": [
    {
      "includes": ["src/main/**", "src/preload/**"],
      "javascript": { "globals": ["__dirname", "__filename", "process", "Buffer"] }
    },
    {
      "includes": ["src/renderer/**"],
      "linter": { "rules": { "suspicious": { "noConsole": "warn" } } }
    }
  ]
}
```

`overrides[].includes` 与 `javascript.globals` 的字段名已按官方 configuration 参考核对。

---

## 5. Zustand 在 Electron 中的用法

版本：`zustand@5.0.15`（peer `react >=18`）。

### 5.1 跨进程状态边界（原则：真源在主进程，视图状态在渲染进程）

**必须/建议放主进程**（渲染进程拿不到、或必须跨窗口一致）：
- 资产库索引、文件系统扫描结果与进度、文件监听事件；
- 应用配置、窗口/最近打开列表、任何要长期可靠落盘的业务数据；
- 需要 fs / child_process / 原生模块的操。

**放渲染进程（Zustand store）**：
- 纯 UI：当前选中项、筛选/排序、面板开合、表格滚动位置、表单草稿、toast；
- 由主进程推送数据派生出的视图状态。

**不要**把「主进程的真源」整份镜像进渲染进程 store 再双向同步——直接用 IPC 拉取 + 主进程推送事件（`webContents.send`）单向更新。渲染进程的 Zustand 只是「最后一公里的 UI 状态容器」。

### 5.2 与 IPC 的分工

- 渲染进程 → 主进程：`ipcRenderer.invoke` / `ipcMain.handle`（请求-响应，如「读取资产库」「写入设置」）。
- 主进程 → 渲染进程：`webContents.send` / `ipcRenderer.on`（事件推送，如「扫描进度 42%」）。
- **所有跨进程调用都经 preload 的 `contextBridge` 暴露成窄接口**（模板已有 `window.api` / `window.electron` 模式），渲染进程 store 的 action 里去调 `window.api.*`，不直接碰 ipcRenderer。

### 5.3 `persist` 中间件该落哪：

**结论：桌面应用不要以 localStorage 为长期真源，persist 落到主进程文件。**

- localStorage 在 Electron 里是**能持久化的**——它属于 `Session` 数据，默认写在 `app.getPath('userData')`（`sessionData`）下面的 `Local Storage` 目录里。但它：不透明、和 Chromium 的 Cache/GPUCache 混在同一目录、不便备份/迁移/版本化、容量与并发语义受浏览器约束。（来源：electron `docs/api/app.md` §getPath、`docs/api/session.md` §flushStorageData/clearStorageData）
- 更合适的落点：`path.join(app.getPath('userData'), 'my-app-data', '*.json')`（官方明确建议放在 userData 的子目录，避免与 Chromium 自带子目录冲突）。
- Zustand `persist` 支持**自定义 `PersistStorage`**，其 `getItem/setItem/removeItem` 可以是异步的（官方文档给出的 `AsyncStorage`/自定义 storage 示例即异步用法）；配合 `skipHydration: true` + 手动 `rehydrate()` / `onRehydrateStorage` 处理异步水合。`partialize` 只持久化需要落盘的字段，`version` + `migrate` 做数据结构演进。官方还提醒 `createJSONStorage` 不做运行时校验，生产应自己校验（如 Zod）。（来源：Zustand `docs/reference/middlewares/persist.md`、`docs/reference/integrations/persisting-store-data.md`）

**推荐模式（渲染进程持久化 → 主进程文件）：**

```ts
// preload/index.ts（暴露窄接口）
contextBridge.exposeInMainWorld('api', {
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key)
  }
})
```

```ts
// renderer/src/stores/ui.ts
import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'

const ipcStorage: StateStorage = {
  getItem: async (name) => (await window.api.store.get(name)) ?? null,
  setItem: async (name, value) => { await window.api.store.set(name, value) },
  removeItem: async (name) => { await window.api.store.remove(name) }
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({ /* ...UI state... */ }),
    {
      name: 'ui-state',
      storage: createJSONStorage(() => ipcStorage),
      partialize: (s) => ({ selectedIds: s.selectedIds, view: s.view }),
      version: 1
    }
  )
)
```

```ts
// main：把 store:get/set/remove 写成 userData 子目录里的 JSON 文件
// 简单的 main 侧配置可直接用 electron-store@11（ESM-only）替代手写 fs
```

**边界提醒**：持久化的是「UI 偏好」这类可重建状态；业务真源（资产库）应由主进程自己落库（文件/DB），不要绕一圈塞进渲染进程的 persist。

---

## 6. 分发（Linux）

> macOS 部分**不适用**：本项目仅面向 Linux，不需要 Apple Developer 会员（$99/年）、Developer ID 证书、notarytool/`@electron/notarize` 或 Gatekeeper 公证流程；第 6 节不再展开。

### 6.1 electron-builder 在 Linux 的目标格式

`electron-builder` 稳定线 26.x（npm `latest=26.15.3`，`v26` 标签 = **26.16.1**——注意 `latest` 不是最新，建议显式钉版本）。Linux 支持的目标（v26 schema 实测）：`AppImage`、`deb`、`rpm`、`snap`、`flatpak`、`pacman`、`apk`、`freebsd`、`p5p`、`7z`、`zip`、`tar.xz/.lz/.gz/.bz2`、`dir`。

**已验证的默认值**：`app-builder-lib@26.16.1` 的 `scheme.json` 中，`LinuxConfiguration.target` 的 `default` 是 **`"AppImage"`**（v27 文档改为 AppImage + Snap，但那是 alpha 线）。

**Linux 推荐组合**：
- **AppImage + deb**（通用首选）：AppImage 免安装、跨发行版；deb 覆盖 Debian/Ubuntu/Mint 用户。
- 面向 Fedora/RHEL 再加 **rpm**；需要沙箱化分发再加 **flatpak**（需 flatpak-builder）；**snap** 需 snapd/snapcraft，CI 成本高，非必须。
- 纯自建 CDN 分发可用 **tar.gz**。

```yaml
# electron-builder.yml（Linux 节选）
appId: com.example.gameassetmanager
productName: GameAssetManager
directories: { buildResources: build }
files:
  - '!src/*'
  - '!electron.vite.config.{js,ts,mjs,cjs}'
  - '!{.npmrc,pnpm-lock.yaml,biome.json,README.md}'
  - '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
asarUnpack: ['resources/**']
npmRebuild: false
linux:
  target:
    - AppImage
    - deb
  category: Utility
  maintainer: you@example.com
  icon: build/icons            # NxN.png 命名（16/32/48/64/128/256/512）
  syncDesktopName: true        # v26 需要；v27 已恒开
  desktop:
    entry:
      StartupWMClass: com.example.gameassetmanager
# window association：package.json 里设 desktopName: com.example.GameAssetManager
```

> `desktopName`：Electron 用 `package.json` 的 `desktopName` 决定窗口的 `WM_CLASS`/`app_id`，桌面环境据此把运行中的窗口关联到 `.desktop` 启动器。**v26 下还需显式设 `linux.syncDesktopName: true`**（v26 schema 实测其默认值为 `false`），才会用 `desktopName` 生成 `.desktop` 文件名；v27 起该行为恒开（`syncDesktopName` 已移除）。不设 `desktopName` 会导致 GNOME/KDE 任务栏无法关联窗口。

### 6.2 electron-forge makers 的对应物

官方 maker：`@electron-forge/maker-deb`、`maker-rpm`、`maker-zip`、`maker-flatpak`、`maker-snap`（均 7.11.2）。**没有官方 AppImage maker**；AppImage 需要第三方 `electron-forge-maker-appimage`（electron-builder v27 文档称其已转 ESM）。所以「Linux 首选出 AppImage」这一诉求上，electron-builder 更省事。

### 6.3 没有代码签名/公证：好影响与坏影响

**好影响**
- 无需任何证书/账号/付费；CI 不需要密钥材料，构建可完全在普通 Linux runner 上完成。
- 没有 notarytool 往返、没有 Gatekeeper 拦截，发布链路短、失败点少。
- AppImage/tar.gz 用户拿到即可运行。

**坏影响 / 需要额外做的事**
- **没有 OS 级发布者身份**：Linux 没有 macOS Gatekeeper 那种统一拦截，但也没有统一信任链；deb/rpm 若要进入第三方仓库，通常需要 **GPG 签名仓库/包**，否则 apt/dnf 会有告警甚至拒绝。
- **自动更新完整性**：`electron-updater` 在没有代码签名时只能依赖 TLS + 自己在发布侧做签名/校验；建议对更新包做哈希/签名校验。
- 部分企业发行版/受管环境要求签名包，未签名可能被策略拦。
- 用户侧「未知来源」提示因发行版而异（AppImage 双击、deb 安装时的权限提示等），无法用签名消除。

### 6.4 Linux 沙箱与 `chrome-sandbox` / user namespace

Chromium 在 Linux 上依赖 **setuid 的 `chrome-sandbox`（root 所有，mode 4755）** 或 **非特权 user namespace** 才能启用沙箱；两者都不满足时会直接拒绝启动（Electron renderer 自 Electron 20 起默认 `sandbox: true`）。常见报错：

```
The SUID sandbox helper binary was found, but is not configured correctly. Rather than run
without sandboxing I'm aborting now. You need to make sure that /path/chrome-sandbox is owned
by root and has mode 4755.
```

以及容器里常见的 `No usable sandbox!` / `Failed to move to new namespace`。

**各环境的规避（按优先级）：**
1. **开发机 / 正常桌面**：保持沙箱开启。若用发行版包管理器安装，`chrome-sandbox` 的 SUID 通常已被正确设置；自行解压运行则需要 `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`。
2. **Ubuntu 23.10+ / 24.04**：默认用 **AppArmor 限制非特权 user namespace**（`kernel.apparmor_restrict_unprivileged_userns=1`）。此时 Electron 需要在 AppArmor profile 里放行 `userns,`（Ubuntu 提供 `default_allow` 模式，或为可执行文件建 profile），否则沙箱不可用。（来源：Ubuntu 官方博客 "Restricted unprivileged user namespaces are coming to Ubuntu 23.10"）
3. **容器 / CI / devcontainer（无 SUID、user namespace 被限制）**：这是最常见的失败场景。临时办法是 `--no-sandbox`（**Electron 官方明确标注仅用于测试、不建议生产**；会同时关闭所有进程的沙箱）。更稳的做法是在镜像里以 root 生成 SUID 的 `chrome-sandbox`，或放开 `kernel.unprivileged_userns_clone`。
4. **AppImage 特别注意**：AppImage 挂载的文件系统里无法保留 SUID（squashfs + FUSE），所以 AppImage 运行 Electron 常常必须依赖 user namespace。
   - **electron-builder v26**：默认 `toolsets.appimage = "0.0.0"`（Legacy FUSE2 runtime），官方确认此模式下 **electron-builder 会默认注入 `--no-sandbox`**；同时 FUSE2 在新发行版上可能缺失 `libfuse.so.2` 直接启动失败。（来源：v26.16.1 `scheme.json`、maintainer 在 issue #9659 的回复）
   - **electron-builder v27**：默认 `toolsets.appimage = "1.1.0"`（static FUSE3 运行时），`AppRun` 做智能探测，**只在 user namespace 不可用时**才加 `--no-sandbox`；v26 也可显式 `toolsets: { appimage: "1.0.3" }` 用上较新的运行时（v26 schema 接受 `1.0.2`/`1.0.3`）。
   - 需要强制/禁用时可显式设 `linux.executableArgs`（如 `["--no-sandbox"]`）。
   （来源：electron-builder master `website/docs/appimage.md`、`migration/v27-breaking-changes.md`、issue #9659/#9590）

### 6.5 x64 与 arm64 支持现状

- **Electron 官方**：Linux 提供 `x64 (amd64)` 与 `arm64` 二进制；README 的平台支持列表只列这两者（armv7l 已不在列）。预编译二进制在 Ubuntu 上构建。（来源：electron `README.md` §Platform support）
- **electron-builder**：
  - `--linux --x64` / `--linux --arm64` 分别出包；AppImage/deb/rpm 均有 arm64 变体。
  - v27 起 `arch: "all"` 展开为 **x64 + arm64**；32 位（ia32）在 **Electron 44+ 直接失败**，armv7l 也要求 `electronVersion <= 43.x`。（来源：`migration/v27-breaking-changes.md`）
- **实践建议**：主目标 **x64 + arm64 两个 AppImage**，deb/rpm 至少 x64。arm64 可在 x64 主机上通过 electron-builder 的 docker 镜像或对应工具链构建（跨架构 deb/rpm 需要 `fpm` 工具链，**未在本环境实测**）。

---

## 7. 推荐组合（可直接照抄的清单）

### 7.1 构建器与运行时

- 构建器：**electron-vite 5.0.0**
- Vite：**7.3.6**（`~7.3.6`，**不要**装到 8.x，electron-vite 5 的 peer 不支持）
- React 插件：**@vitejs/plugin-react 5.1.1**
- Electron：**44.4.5**
- Node：**22.12+ / 24 LTS**（electron-vite engines `^20.19 || >=22.12`；Electron 44 要求 `>=22.12`）

> 想上 Vite 8 的替代路线：`electron-vite@6.0.0-beta.1` + `vite@8.3.1` + `@vitejs/plugin-react@6.1.1`。这是 beta，不作为首选。

### 7.2 目录结构（单包起步）

```
game-asset-manager/
├── electron.vite.config.ts
├── electron-builder.yml
├── biome.json
├── package.json
├── tsconfig.json
├── tsconfig.node.json          # main + preload + electron.vite.config.*
├── tsconfig.web.json           # renderer + src/preload/*.d.ts
├── .npmrc                      # shamefully-hoist=true
├── build/
│   ├── icons/                  # 16/32/48/64/128/256/512 的 NxN.png
│   └── entitlements.mac.plist  # 仅 macOS 用；Linux 项目可删
└── src/
    ├── main/
    │   ├── index.ts            # app + BrowserWindow + IPC handlers
    │   └── store.ts            # userData 子目录的 JSON 持久化
    ├── preload/
    │   ├── index.ts            # contextBridge 暴露 window.api
    │   └── index.d.ts
    ├── shared/                 # 仅共享「类型/纯函数」，被 main 和 renderer 共同 import
    │   └── ipc.ts
    └── renderer/
        ├── index.html          # CSP meta
        └── src/
            ├── main.tsx
            ├── App.tsx
            ├── assets/main.css # @import "tailwindcss"; @theme {...}
            └── stores/*.ts     # Zustand
```

**单包 vs pnpm workspace**：
- 起步选**单包**。理由：electron-vite 的依赖处理默认把 main/preload 的 `dependencies` 外部化（打包时由 electron-builder 带上），一旦拆成 workspace，「主进程依赖 / 渲染进程依赖 / 共享包」的归属很容易踩到外部化与 hoisting 的坑。
- 需要拆分时，**推荐的 workspace 形态**是「app 包 + 共享纯 TS 包」，且：
  - 根 `.npmrc` 写 `shamefully-hoist=true`（electron-vite 官方对 pnpm 的唯一明确建议），或 `node-linker=hoisted`；
  - 共享包只放类型/纯函数（不碰 Electron API、不碰 fs），这样 main 与 renderer 都能安全 import；
  - 渲染进程要 Tailwind 扫到共享包时，用 `@source` 指过去（见 3.3）。
  - 注意：electron-builder 26.x 在 pnpm hoisted 模式下有未修复的依赖收集 bug（issue #10228，2026-09-23，pnpm 11 + `node-linker=hoisted`；同代码在 26.15.3/26.16.1），**workspace + pnpm 是本方案里风险最高的一环**。

### 7.3 `package.json`（关键部分与版本）

```json
{
  "name": "game-asset-manager",
  "version": "0.1.0",
  "main": "./out/main/index.js",
  "desktopName": "com.example.GameAssetManager",
  "scripts": {
    "dev": "electron-vite dev",
    "start": "electron-vite preview",
    "build": "pnpm typecheck && electron-vite build",
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json --composite false",
    "typecheck:web": "tsc --noEmit -p tsconfig.web.json --composite false",
    "typecheck": "pnpm typecheck:node && pnpm typecheck:web",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "build:linux": "pnpm build && electron-builder --linux --config",
    "build:unpack": "pnpm build && electron-builder --dir"
  },
  "dependencies": {
    "@electron-toolkit/preload": "^3.0.2",
    "@electron-toolkit/utils": "^4.0.0",
    "zustand": "^5.0.15"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.14",
    "@electron-toolkit/tsconfig": "^2.0.0",
    "@tailwindcss/vite": "^4.3.3",
    "@types/node": "^24.19.0",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^5.1.1",
    "electron": "^44.4.5",
    "electron-builder": "26.16.1",
    "electron-vite": "^5.0.0",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "tailwindcss": "^4.3.3",
    "typescript": "~5.9.3",
    "vite": "~7.3.6"
  }
}
```

> **ESM 取舍（本项目要先定夺的一点）**：上面刻意**不加** `"type": "module"`，即 main/preload 走 **CJS**，与官方模板一致、风险最低。若想用主进程 ESM（Electron 28+ 支持），加 `"type": "module"`，electron-vite 会把 main 和 preload 都输出为 ESM，**preload 产物变为 `.mjs` 且必须 unsandboxed（`sandbox: false`）**，同时要把 `BrowserWindow` 里的 preload 路径改成 `../preload/index.mjs`。也就是说「ESM preload」与「`sandbox: true`」不能同时成立（官方限制）。想在保留 `sandbox: true` 的同时用 ESM 主进程，需要额外把 preload 的输出格式单独设为 `cjs` 并配合 `isolatedEntries: true` + `externalizeDeps: false` 打单文件——**该组合未实测**（见第 8 节）。

### 7.4 `.npmrc`

```ini
shamefully-hoist=true
```

（electron-vite 官方 troubleshooting 对 pnpm 的建议；作用是让依赖按扁平结构落盘，避免打包时找不到模块。用 workspace/`node-linker=hoisted` 时注意 7.2 提到的 builder bug。）

### 7.5 `electron.vite.config.ts`

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // 默认 CJS 输出；若要 ESM，需在 package.json 加 "type": "module"
    // 并同步把 BrowserWindow 的 preload 路径改为 ../preload/index.mjs
  },
  preload: {
    build: {
      // 若要 sandbox: true：打单文件 preload
      // isolatedEntries: true,
      // externalizeDeps: false
    }
  },
  renderer: {
    resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()]
  }
})
```

### 7.6 `src/renderer/index.html` 的 CSP

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
/>
```

开发态若 HMR 报 CSP 拦截，需临时追加 `connect-src 'self' ws: http://localhost:*`。

### 7.7 Linux 打包

- `electron-builder.yml`：见 6.1；Linux target = `AppImage` + `deb`（可加 `rpm`）。
- 建议显式开启较新 AppImage 运行时，避免 FUSE2/强制 `--no-sandbox`：

```yaml
toolsets:
  appimage: "1.0.3"   # v26 线；v27 默认已是 1.1.0
```

- 出包命令：`pnpm build:linux`（x64）；arm64 追加 `--arm64`。

---

## 8. 未能验证 / 开放问题

以下条目**尚未在本环境实测或官方文档未完全覆盖**，实施前需各自验证：

1. **`electron-vite@5.0.0` 与 Electron 44 的兼容性**：v5 changelog 只提到 "build compatibility target for Electron 39"，未见对 Electron 40–44 的明确声明。预计可用（构建 target 只是 esbuild 预设），但**未验证**。
2. **TypeScript 版本选择**：registry `latest = 7.0.2`（另有 `6.0.3`），但 Biome 文档只声明「支持 TypeScript 5.9 语法」，electron-vite 官方模板钉 `^5.9.3`。因此本报告推荐 `~5.9.3`；**TS 6.0.x / 7.0.x 与 Biome/electron-vite 的实际兼容性未验证**。
3. **pnpm workspace + electron-builder 26.16.1 的依赖收集**：issue #10228（pnpm 11 + `node-linker=hoisted`，2026-09-23，仍 open）报告打包后嵌套依赖版本被 root 覆盖；#9025 报告 symlink 拷贝失败。本报告建议先用单包 + `shamefully-hoist=true` 规避，但**该组合在本项目结构下未实测**。
4. **开发态 CSP 的精确最小集**：Vite HMR 需要哪些 `connect-src`/`script-src` 放行，以及生产构建能否去掉 `style-src 'unsafe-inline'`，**未实测**。
5. **v26 下 `toolsets.appimage: "1.0.3"` 的智能沙箱探测行为**：master/v27 文档描述了 static runtime 的探测逻辑，但 v26.16.1 上是否完全一致**未验证**（v26 schema 只确认该值合法）。
6. **Biome 在 Electron 三环境下的最终配置形态**：`overrides` 与「嵌套 `biome.json`」两种方案官方都支持，但与编辑器 LSP 在 `src/main` / `src/preload` / `src/renderer` 布局下的协作细节**未实测**，本报告示例基于官方字段。
7. **Zustand `persist` + 异步 IPC storage 的边界**：官方文档以 `AsyncStorage` 示例示意异步 storage，但**未给出 Electron/异步水合的完整范例**；`skipHydration` + 手动 `rehydrate()` 的时序需自行测试。
8. **arm64 包在 x64 主机上的跨架构构建**：deb/rpm 的 arm64 变体需要额外工具链（fpm 等），**未实测**。
9. **Biome Tailwind domain**：规则目前全是 nursery（`noTailwindArbitraryValue` / `noTailwindRawColors` / `useTailwindShorthandClasses`），`recommended` 不会启用任何规则；是否值得显式开 `all` **未评估**。
10. **`electron-builder` 版本钉选**：npm `latest` 标签停在 26.15.3，而 `v26` 标签是 26.16.1；本报告建议钉 `26.16.1`，但**未验证该版本相对 `latest` 的回归风险**（issue #10228 称两者代码相同）。
11. **「ESM 主进程 + sandboxed preload」组合**：把 preload 输出格式单独设为 `cjs`（生成 `.cjs`）+ `isolatedEntries: true` + `externalizeDeps: false`，是否能在 `"type": "module"` 下与 `sandbox: true` 共存，官方文档未给出完整示例，**未实测**。

---

## 附：证据来源（全部为官方一手来源）

- electron-vite 官方文档（electron-vite.org / `alex8088/electron-vite-docs`）：`guide/dev.md`（入口约定、ESM、nodeIntegration、sandbox 限制）、`guide/hmr-and-hot-reloading.md`、`guide/isolated-build.md`、`guide/dependency-handling.md`、`guide/distribution.md`、`guide/troubleshooting.md`（pnpm → `shamefully-hoist=true`）。
- electron-vite 官方模板（`alex8088/quick-start`，`template/react-ts`）：`package.json`、`electron.vite.config.ts`、`electron-builder.yml`、`src/main/index.ts`（`sandbox: false`）、`src/preload/index.ts`、`src/renderer/index.html`（CSP）、`tsconfig.node.json` / `tsconfig.web.json`。
- Electron 官方文档（`electron/electron`）：`README.md`（平台支持）、`docs/api/structures/web-preferences.md`、`docs/breaking-changes.md`、`docs/tutorial/sandbox.md`、`docs/tutorial/security.md`、`docs/tutorial/code-signing.md`、`docs/api/app.md`（userData/sessionData）、`docs/api/session.md`、`docs/api/command-line-switches.md`（`--no-sandbox`）。
- Tailwind CSS 官方文档（tailwindcss.com / `tailwindlabs/tailwindcss.com`）：`docs/detecting-classes-in-source-files`（CWD 基准、`@source`/`@source not`/`source(none)`/`@source inline`）、`docs/functions-and-directives`（`@config`、`@theme`）、`docs/theme`、`docs/upgrade-guide`、`docs/installation/*`。
- Biome 官方文档（biomejs.dev / `biomejs/website`）：`internals/language-support`（各语言支持矩阵与缺口）、`linter/index`（domains、suppressions）、`linter/domains`（含 Tailwind domain）、`reference/configuration`（`files.includes`、`overrides`、`javascript.globals`、`css.parser.tailwindDirectives`）、`guides/configure-biome`（`files.includes` 与工具级 includes 的语义、嵌套配置）、`guides/big-projects`（monorepo / `extends: "//"`）、`guides/migrate-eslint-prettier`、`blog/biome-v2-0-beta`（type-aware 局限）。
- Zustand 官方文档（`pmndrs/zustand`）：`docs/reference/middlewares/persist.md`（`storage`/`partialize`/`version`/`migrate`/`skipHydration`、自定义 PersistStorage）、`docs/reference/integrations/persisting-store-data.md`（`createJSONStorage`）、`docs/reference/apis/create-store.md`、README（vanilla store、`subscribe` 瞬态更新）。
- Electron Forge 官方文档/源码（`electron/forge`）：`docs/templates/vite-+-typescript.md`、`packages/plugin/vite/README.md`（`hotRestart` 默认关闭、`build[]`/`renderer[]`）、`docs/config/makers/index.mdx`、`packages/template/vite-typescript/tmpl/main.ts`。
- electron-builder 官方文档/发布物（`electron-userland/electron-builder`）：`website/docs/linux.md`、`website/docs/appimage.md`、`website/docs/notarization.md`、`website/docs/mac.md`、`website/docs/migration/v27-breaking-changes.md`、`app-builder-lib@26.16.1` 的 `scheme.json`（Linux 默认 target、`toolsets.appimage` 默认值、v26 mac 配置键）、GitHub issue #9659 / #10228 / #9025。
- Ubuntu 官方博客：*Restricted unprivileged user namespaces are coming to Ubuntu 23.10*（AppArmor `userns,`、`kernel.apparmor_restrict_unprivileged_userns`）。
- 版本数据：npm registry（`npm view <pkg> version|dist-tags|peerDependencies|engines|time`），查询日期 2026-09-26。
