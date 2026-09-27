/**
 * 审计留痕（`#13`）：写入类工具调用落一行 JSONL，供事后核对。
 *
 * 单独成模块的原因：它是浏览器半（`page_open`）与台账半（同步 / 落库 / 揭示 / 兑换）
 * **共享的服务**，不该被任一半拥有；`host.ts` 建一份、注入两半。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

export interface AuditEntry {
  at: string
  tool: string
  keyIds?: number[]
  written?: number
  /** 写入页面行的码时吸收掉的同单同码 `api:` 补充行条数（ADR-0004 修订）。 */
  absorbed?: number
  detail?: unknown
}

/** 记一次留痕，返回 `<时间>#<工具名>` 形式的审计 id。 */
export type AuditLogger = (entry: AuditEntry) => Promise<string>

/** 建审计器。落盘路径在建宿主时确定一次（与拆分前 `createMcpHost` 的时机一致）。 */
export function createAuditLogger(): AuditLogger {
  const artifactsDir = join(app.getPath('userData'), 'mcp-artifacts')
  const auditPath = join(app.getPath('userData'), 'mcp-audit.jsonl')

  return async function appendAudit(entry: AuditEntry): Promise<string> {
    await mkdir(join(artifactsDir, '..'), { recursive: true })
    await writeFile(auditPath, `${JSON.stringify(entry)}\n`, { flag: 'a', encoding: 'utf8' })
    return `${entry.at}#${entry.tool}`
  }
}
