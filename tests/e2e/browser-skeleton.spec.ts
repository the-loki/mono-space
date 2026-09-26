import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'

interface TestHooks {
  reports(): Array<Record<string, unknown>>
  openStoreView(
    url: string,
    options?: { partition?: string; urls?: string[]; show?: boolean },
  ): Promise<{ id: number; url: string; status: number; title: string }>
  loadExtension(extensionPath: string, partition?: string): Promise<{ id: string; version: string }>
  swapExtension(
    extensionId: string,
    extensionPath: string,
    partition?: string,
  ): Promise<{ id: string; version: string }>
  closeAllWindows(): number
}

declare global {
  var __monoSpaceTest: TestHooks
}

interface Harness {
  port: number
  lastHeaders: () => IncomingHttpHeaders
  close: () => Promise<void>
}

async function startHarness(): Promise<Harness> {
  let headers: IncomingHttpHeaders = {}
  const server: Server = createServer((request, response) => {
    headers = request.headers
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><title>harness</title></head><body>ok</body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    lastHeaders: () => headers,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

async function launchApp(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['out/main/index.js', '--no-sandbox'],
    env: {
      ...process.env,
      MS_TEST: '1',
      DISPLAY: process.env.DISPLAY || ':198',
    },
  })
}

const LOCAL_URLS = ['*://127.0.0.1/*']

test('client hints 注入：store session 的出网带上 Sec-CH-UA', async () => {
  const harness = await startHarness()
  const app = await launchApp()
  try {
    const result = await app.evaluate(
      (_electron, { url, urls }) =>
        globalThis.__monoSpaceTest.openStoreView(url, { urls, show: false }),
      { url: `http://127.0.0.1:${harness.port}/echo`, urls: LOCAL_URLS },
    )
    expect(result.status).toBe(200)
    const headers = harness.lastHeaders()
    expect(headers['sec-ch-ua']).toContain('Chromium')
    expect(headers['sec-ch-ua-platform']).toBe('"Linux"')
    expect(headers['sec-ch-ua-mobile']).toBe('?0')
  } finally {
    await app.close()
    await harness.close()
  }
})

test('MV3 扩展可装载、content script 经桥上报、且可运行期热替换', async () => {
  const harness = await startHarness()
  const app = await launchApp()
  const source = join(process.cwd(), 'tests/fixtures/extension-mv3')
  const upgraded = join(process.cwd(), 'tests/fixtures/extension-mv3-v2')
  // 热替换要沿用同一条磁盘路径（扩展 id 由路径推导），故拷到临时目录再覆盖。
  const workDir = mkdtempSync(join(tmpdir(), 'ms-ext-'))
  const files = ['manifest.json', 'sw.js', 'content.js']
  for (const file of files) copyFileSync(join(source, file), join(workDir, file))

  const partition = 'persist:ext-test'
  const pageUrl = `http://127.0.0.1:${harness.port}/page`

  try {
    const installed = await app.evaluate(
      (_electron, { path, part }) => globalThis.__monoSpaceTest.loadExtension(path, part),
      { path: workDir, part: partition },
    )
    expect(installed.version).toBe('1.0')

    await app.evaluate(
      (_electron, { url, part, urls }) =>
        globalThis.__monoSpaceTest.openStoreView(url, { partition: part, urls, show: false }),
      { url: pageUrl, part: partition, urls: LOCAL_URLS },
    )

    await expect
      .poll(async () => (await app.evaluate(() => globalThis.__monoSpaceTest.reports())).length)
      .toBeGreaterThan(0)

    const first = await app.evaluate(() => globalThis.__monoSpaceTest.reports())
    expect(first[0]).toMatchObject({ marker: 'sw-v1', manifestVersion: 3 })

    // 热替换：同一路径覆盖成新版，再 removeExtension + loadExtension（不重启应用）。
    for (const file of files) copyFileSync(join(upgraded, file), join(workDir, file))
    const swapped = await app.evaluate(
      (_electron, { id, path, part }) => globalThis.__monoSpaceTest.swapExtension(id, path, part),
      { id: installed.id, path: workDir, part: partition },
    )
    expect(swapped.version).toBe('1.1')
    expect(swapped.id).toBe(installed.id)

    const before = (await app.evaluate(() => globalThis.__monoSpaceTest.reports())).length
    await app.evaluate(
      (_electron, { url, part, urls }) =>
        globalThis.__monoSpaceTest.openStoreView(url, { partition: part, urls, show: false }),
      { url: pageUrl, part: partition, urls: LOCAL_URLS },
    )
    await expect
      .poll(async () => (await app.evaluate(() => globalThis.__monoSpaceTest.reports())).length)
      .toBeGreaterThan(before)

    const all = await app.evaluate(() => globalThis.__monoSpaceTest.reports())
    expect(all.some((report) => report.marker === 'sw-v2')).toBe(true)
  } finally {
    await app.close()
    await harness.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

// 真实站点测试默认不跑（#15 测试策略：真实站点不入 CI），用 MS_NET_TESTS=1 手动开。
// 注意：Cloudflare managed challenge 是**有状态**的（同一出口 IP 会 200/403 抖动，见
// docs/verify/16-embedded-browser.md），故允许同会话重试，只要求最终能拿到 200。
// 「client hints 是否真的注入」由上面的离线 echo 测试确定性证明。
test('（手动）未登录下 fab.com / Epic 兑换页可放行（CF 有状态，允许重试）', async () => {
  test.skip(!process.env.MS_NET_TESTS, '设置 MS_NET_TESTS=1 才跑真实站点')
  const app = await launchApp()
  try {
    for (const url of [
      'https://www.fab.com/',
      'https://www.epicgames.com/account/code-redemption',
    ]) {
      const statuses: number[] = []
      for (let attempt = 0; attempt < 5 && !statuses.includes(200); attempt++) {
        const result = await app.evaluate(
          (_electron, target) => globalThis.__monoSpaceTest.openStoreView(target, { show: false }),
          url,
        )
        statuses.push(result.status)
      }
      console.log('[网络冒烟]', url, statuses)
      expect(statuses, url).toContain(200)
    }
  } finally {
    await app.close()
  }
})
