/**
 * 导出落盘：把导出的 JSON / CSV 保存到用户选定的文件。
 *
 * 为什么单独一个模块：**这里要能单测**。`dialog` / `fs` 都是副作用，直接写进 IPC handler 就只能靠
 * 真机点一遍（而且原生对话框没法在无头环境里点）。所以把「选路径」与「写文件」抽成注入依赖，
 * 只留纯逻辑与编排在这里 —— 文件名规则、取消语义、写失败往上抛，全都能用测试钉住。
 *
 * 背景（`docs/verify/33-full-test.md` §0 问题 1）：导出原先只是把文本算出来交给渲染层，
 * 渲染层只用了它的长度显示一句「已生成 JSON（499077 字符）」，**数据被丢掉**，用户拿不到任何文件。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  KeyQuery,
  LedgerExportFormat,
  LedgerExportSaveResult,
} from '../../shared/ipc-contract'

/** 导出范围与格式。 */
export interface ExportRequest {
  format: LedgerExportFormat
  query: KeyQuery
}

/**
 * 保存结果：用户取消不是错误（`saved: false`，什么都没写）。
 * 类型就是契约里的那一个（渲染层也看得见），不另起名字。
 */
export type SaveExportResult = LedgerExportSaveResult

/** 选路径与写文件（注入以便测试；真实实现见 `createDefaultSaveDeps`）。 */
export interface SaveExportDeps {
  /** 弹保存对话框；返回 null 表示用户取消。第一个参数是**建议文件名**（不是路径）。 */
  pickPath: (suggestedName: string, title: string) => Promise<string | null>
  /** 写文件；失败要抛（界面需要看到原因）。 */
  writeFile: (path: string, text: string) => Promise<void>
}

/** 本地日期 `YYYY-MM-DD`（文件名用本地日期：用户看到的是自己的日历）。 */
function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 默认文件名。**把导出范围写进名字**：明细视图下只导这一单，若文件名和全量一样，
 * 存两次就分不清哪个是哪个（实测踩过「导出的是哪一份」的困惑）。
 */
export function defaultExportFileName(request: ExportRequest, now: Date = new Date()): string {
  const ext = request.format === 'csv' ? 'csv' : 'json'
  const date = localDate(now)
  const orderId = request.query.orderRemoteId
  return orderId ? `monospace-order-${orderId}-${date}.${ext}` : `monospace-ledger-${date}.${ext}`
}

/** 保存对话框的标题（跟着范围走，别让用户在两个视图里看到同一句话）。 */
export function exportDialogTitle(request: ExportRequest): string {
  return request.query.orderRemoteId ? '导出这一单的 key' : '导出全部台账'
}

/**
 * 走完「选路径 → 写文件」。
 *
 * 取消返回 `{saved:false}` 且**不写任何文件**；写失败直接抛（界面据此显示原因，不要静默）。
 */
export async function saveExportFile(
  deps: SaveExportDeps,
  request: ExportRequest,
  text: string,
  now: Date = new Date(),
): Promise<SaveExportResult> {
  const path = await deps.pickPath(defaultExportFileName(request, now), exportDialogTitle(request))
  if (path === null) {
    return { saved: false }
  }
  await deps.writeFile(path, text)
  return { saved: true, path }
}

/**
 * 真实写文件：导出内容**含兑换码明文**（这是「导出」的用途），用 `0600`，不该让同机其他用户读得到
 * —— 与 `agent/config.ts` 写 auth.json 的做法一致。
 */
const writePrivateFile = async (path: string, text: string): Promise<void> => {
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
}

/**
 * 真实依赖 + **测试缝**：`MS_EXPORT_DIR` 指向目录时**不弹对话框**，直接存到该目录。
 *
 * 为什么需要这个缝：原生保存对话框**没法在无头环境里点**（本机连 xdotool 都没有），
 * 没有缝的话「导出真的落盘了吗」只能靠人点一遍、且 e2e 永远覆盖不到。
 * 本仓库已有同样的做法：`MS_LEDGER_DB` 覆盖库路径、`MS_TEST` 装测试钩子。
 *
 * 行为：`MS_EXPORT_DIR` 为空/纯空白 ⇒ 照旧弹对话框（默认路径不变）。
 */
export function createSaveDeps(
  env: NodeJS.ProcessEnv,
  showSaveDialog: (suggestedName: string, title: string) => Promise<string | null>,
): SaveExportDeps {
  const dir = env.MS_EXPORT_DIR?.trim()
  if (!dir) {
    return createDefaultSaveDeps(showSaveDialog)
  }
  return {
    pickPath: async (suggestedName) => join(dir, suggestedName),
    writeFile: writePrivateFile,
  }
}

/** 真实依赖：Electron 保存对话框 + 上面的 `writePrivateFile`。 */
export function createDefaultSaveDeps(
  showSaveDialog: (suggestedName: string, title: string) => Promise<string | null>,
): SaveExportDeps {
  return { pickPath: showSaveDialog, writeFile: writePrivateFile }
}
