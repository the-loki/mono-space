import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  // ESM 主进程 + sandboxed preload 共存：preload 单独输出 cjs（.cjs）。
  // 注意：不要开 `isolatedEntries`——electron-vite 5 的 isolate-entries 插件在
  // stdout 非 TTY（CI / 管道）时会因 `process.stdout.moveCursor` 不存在而崩。
  // 单 preload 入口本就不需要它；`externalizeDeps:false` 保证依赖被打进单文件。
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
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
  },
})
