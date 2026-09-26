研究 #5 结论：electron-vite 5 + Vite 7 + electron-builder 26，Linux 出 AppImage+deb。

- 构建器：electron-vite 5.0.0（peer 仅 vite ^5/^6/^7，故钉 vite 7.3.6；vite@latest 8.3.1 需 electron-vite 6 beta）。forge 无官方 AppImage maker、主进程热重启默认关，手搭不建议。
- Tailwind 4.3.3：`@tailwindcss/vite` + CSS-first，不必 `tailwind.config.js`；扫描基准是 CWD，monorepo 要用 `@source` 修正。
- Biome 2.5.14：JS/TS/CSS 全覆盖；Markdown/YAML/SCSS 缺失、不做类型检查（`tsc --noEmit` 另跑）；Tailwind 需 `css.parser.tailwindDirectives=true`；主/预/渲染三环境用 `files.includes`+`overrides`。
- Zustand 5.0.15：只管渲染进程 UI 状态，真源留主进程；`persist` 用「主进程文件 + IPC 自定义 storage」而非 localStorage。
- 结构先单包；pnpm workspace 需 `shamefully-hoist=true`，且 electron-builder 26 的 pnpm hoisted 依赖收集有未修 bug（#10228）。
- Linux：v26 默认 AppImage（FUSE2）会注入 `--no-sandbox`，建议 `toolsets.appimage="1.0.3"`；无签名/公证利好 CI，仓库分发需自签；容器 / Ubuntu 24.04 userns 受限是主要沙箱坑。
- 完整报告：`docs/research/electron-scaffold.md`（验证日期 2026-09-26，含 11 项未验证/开放问题）。
