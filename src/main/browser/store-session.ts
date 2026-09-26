import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Session, session } from 'electron'
import { installClientHints, STORE_URL_PATTERNS } from './client-hints'

/** 应用私有的 store 分区：登录态只落在这里，与用户日常浏览器隔离。 */
export const STORE_PARTITION = 'persist:store'

const currentDir = dirname(fileURLToPath(import.meta.url))
const BRIDGE_PRELOAD = join(currentDir, '../preload/bridge.cjs')
const BRIDGE_ID = 'mono-space-bridge'

export interface StoreSessionOptions {
  partition?: string
  /** 测试可覆盖：默认只对 store 站点注入 client hints。 */
  urls?: string[]
}

const prepared = new Set<string>()

/**
 * 建/取应用私有的 store 分区，并装上两样东西：
 * 1. client hints 注入（ADR-0002，否则 fab / epicgames 直接 403）；
 * 2. 会话级 bridge preload（扩展 content script → 主进程的通道）。
 */
export function createStoreSession(options: StoreSessionOptions = {}): Session {
  const partition = options.partition ?? STORE_PARTITION
  const storeSession = session.fromPartition(partition)

  if (!prepared.has(partition)) {
    installClientHints(storeSession, options.urls ?? STORE_URL_PATTERNS)
    registerBridge(storeSession)
    prepared.add(partition)
  }

  return storeSession
}

let cached: Session | null = null

/** 主进程单例入口：整个应用共用一个 store 分区。 */
export function getStoreSession(): Session {
  if (!cached) cached = createStoreSession()
  return cached
}

function registerBridge(storeSession: Session): void {
  // Electron 44 的会话级 preload 注册（返回注册 id）。
  storeSession.registerPreloadScript({ id: BRIDGE_ID, type: 'frame', filePath: BRIDGE_PRELOAD })
}
