import { defineConfig } from 'vitest/config'

// 数据层是纯 TS（不依赖 electron），单测直接跑在 Node 环境。
// 用 node:sqlite 做内存库，无需原生编译。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
  },
})
