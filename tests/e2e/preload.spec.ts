import { _electron as electron, expect, test } from '@playwright/test'

// 验收：ESM 主进程 + sandboxed `.cjs` preload 共存，且 contextBridge 往返成立。
test('ESM 主进程与 sandboxed preload 的 contextBridge 往返', async () => {
  const app = await electron.launch({
    args: ['out/main/index.js', '--no-sandbox'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':198' },
  })

  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('ping-result')).toHaveText('pong:hello')
  } finally {
    await app.close()
  }
})
