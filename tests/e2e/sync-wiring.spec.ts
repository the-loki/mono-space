import { _electron, expect, test } from '@playwright/test'

/**
 * 同步链路接通性（需要网络，故手动开：`MS_NET_TESTS=1`）。
 *
 * 未登录时 Humble 的只读 GET 返回 401（研究 §4.1：GET 不受 Cloudflare 阻挡），
 * 因此这条断言是**确定性的**：不依赖账号，但证明了整条链路真的通——
 * 渲染进程按钮 → preload API → IPC → store 会话 fetch → humblebundle.com → 结构化错误。
 */
test('（手动）台账「同步」按钮经真实 IPC 打到 Humble，未登录时给出结构化提示', async () => {
  test.skip(!process.env.MS_NET_TESTS, '设置 MS_NET_TESTS=1 才跑（需要网络）')

  const app = await _electron.launch({
    args: ['out/main/index.js', '--no-sandbox'],
    env: { ...process.env, MS_TEST: '1', DISPLAY: process.env.DISPLAY || ':198' },
  })

  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('ledger-sync')).toBeVisible({ timeout: 30_000 })

    const result = (await page.evaluate(() => window.api.sync.run())) as {
      ok: boolean
      reason?: string
    }

    // 没有登录态时必须走「明确的未登录提示」，而不是静默失败或崩掉。
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-logged-in')
  } finally {
    await app.close()
  }
})
