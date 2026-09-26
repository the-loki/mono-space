import { BrowserWindow, type Session } from 'electron'

/** 关掉某个 store 会话下已打开的所有窗口（登录窗口也在这个会话里，会被一并收掉）。 */
export function closeStoreViews(storeSession: Session): number {
  let closed = 0
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.session === storeSession) {
      window.destroy()
      closed += 1
    }
  }
  return closed
}

export interface StoreViewResult {
  id: number
  url: string
  status: number
  title: string
}

/**
 * 打开一个可见的 store 视图（窗口默认可见、可随时人工接管）。
 * 返回导航结果，便于测试断言 HTTP 状态（例如 client hints 是否生效）。
 */
export async function openStoreView(
  storeSession: Session,
  url: string,
  options: { show?: boolean; exclusive?: boolean } = {},
): Promise<StoreViewResult> {
  // 过程类页面互斥（`#31` 用户决策）：同步 / 兑换 / 揭示各是一个过程，
  // 同一时刻只应开一个页面，所以开新页面前把同会话的旧页面关掉。
  if (options.exclusive) closeStoreViews(storeSession)

  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: options.show ?? true,
    webPreferences: { session: storeSession, sandbox: true },
  })

  const status = await new Promise<number>((resolve) => {
    const done = (code: number): void => resolve(code)
    window.webContents.once('did-navigate', (_event, _url, httpResponseCode) =>
      done(httpResponseCode),
    )
    window.webContents.once('did-fail-load', (_event, errorCode) => done(errorCode))
    window.loadURL(url).catch(() => done(-1))
  })

  return {
    id: window.id,
    url: window.webContents.getURL(),
    status,
    title: window.webContents.getTitle(),
  }
}
