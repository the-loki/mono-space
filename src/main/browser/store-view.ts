import { BrowserWindow, type Session } from 'electron'

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
  options: { show?: boolean } = {},
): Promise<StoreViewResult> {
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
