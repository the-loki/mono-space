import type { Session } from 'electron'

export interface LoadedExtension {
  id: string
  name: string
  version: string
}

function toExtension(raw: Electron.Extension): LoadedExtension {
  return { id: raw.id, name: raw.name, version: raw.version }
}

/**
 * 装载 MV3 生成扩展。约束（见 docs/verify/16-embedded-browser.md）：
 * 只能装进 `persist:` 分区、每次启动都要重新 loadExtension、不能装 `.crx`。
 */
export async function loadStoreExtension(
  storeSession: Session,
  extensionPath: string,
): Promise<LoadedExtension> {
  const extension = await storeSession.extensions.loadExtension(extensionPath, {
    allowFileAccess: true,
  })
  return toExtension(extension)
}

/** 运行期热替换：移除旧版再装新版（扩展 id 不变，便于主进程持有引用）。 */
export async function swapStoreExtension(
  storeSession: Session,
  extensionId: string,
  extensionPath: string,
): Promise<LoadedExtension> {
  storeSession.extensions.removeExtension(extensionId)
  return loadStoreExtension(storeSession, extensionPath)
}
