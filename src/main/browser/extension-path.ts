/**
 * 定位内置 MV3 扩展目录（运行时要用真实磁盘路径 `loadExtension`）。
 *
 * 开发态：仓库源码目录；打包态：electron-builder 复制到 `resources/<name>`
 * （见 electron-builder.yml 的 extraResources）。
 */
import { join } from 'node:path'
import { app } from 'electron'

export type BundledExtension = 'redeem-extension'

const SOURCE_DIRS: Record<BundledExtension, string> = {
  'redeem-extension': 'src/main/redeem/extension',
}

export function resolveExtensionPath(name: BundledExtension): string {
  if (app.isPackaged) return join(process.resourcesPath, name)
  return join(app.getAppPath(), SOURCE_DIRS[name])
}
