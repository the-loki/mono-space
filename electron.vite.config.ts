import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  // ESM 主进程 + sandboxed preload 共存：preload 输出 cjs（.cjs）。
  // 注意：不要开 `isolatedEntries`——electron-vite 5 的 isolate-entries 插件在
  // stdout 非 TTY（CI / 管道）时会因 `process.stdout.moveCursor` 不存在而崩。
  // 两个 preload 入口彼此不共享本地模块，rollup 不会拆出沙箱加载不了的共享 chunk，
  // 因此 `externalizeDeps:false` + `.cjs` 输出已足够。
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        // index：应用自身 preload；bridge：store 页面的会话级桥（见 src/preload/bridge.ts）。
        input: {
          index: resolve('src/preload/index.ts'),
          bridge: resolve('src/preload/bridge.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
    // 显式多入口：index 是主界面，debug 是独立的调试日志窗口（见 src/main/debug-window.ts）。
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          debug: resolve('src/renderer/debug.html'),
        },
      },
    },
  },
})
