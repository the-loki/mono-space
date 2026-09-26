/**
 * 定位「兑换扩展」目录。
 *
 * 开发态：直接用仓库里的源码目录；打包态：electron-builder 复制到 `resources/redeem-extension`
 * （见 electron-builder.yml 的 extraResources）。
 */
import { join } from 'node:path'
import { app } from 'electron'

export function resolveRedeemExtensionPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'redeem-extension')
  return join(app.getAppPath(), 'src/main/redeem/extension')
}
