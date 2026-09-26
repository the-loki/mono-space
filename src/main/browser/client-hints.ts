import type { Session } from 'electron'

/** store 站点：这些域名的出网必须补齐 Sec-CH-UA（见 ADR-0002）。 */
export const STORE_URL_PATTERNS = [
  '*://*.fab.com/*',
  '*://*.epicgames.com/*',
  '*://*.humblebundle.com/*',
]

/**
 * Electron 默认完全不发 Sec-CH-UA 客户端提示，会被 Cloudflare 判为可疑并 403。
 * 这里按内置 Chromium 版本拼一份一致的 client hints。
 */
export function clientHintHeaders(
  chromeVersion: string = process.versions.chrome,
): Record<string, string> {
  const major = chromeVersion.split('.')[0] ?? '0'
  return {
    'sec-ch-ua': `"Chromium";v="${major}", "Not:A-Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
  }
}

/** 在给定 session 上装 client hints 注入中间件。 */
export function installClientHints(
  storeSession: Session,
  urls: string[] = STORE_URL_PATTERNS,
): void {
  storeSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    const headers = details.requestHeaders
    const hints = clientHintHeaders()
    for (const [name, value] of Object.entries(hints)) {
      // 先删掉大小写变体，避免重复头；再写入 canonical 小写名。
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name) delete headers[existing]
      }
      headers[name] = value
    }
    callback({ requestHeaders: headers })
  })
}
