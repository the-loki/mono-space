/**
 * 「页面读 → 接口再取一次 → 合并」的编排（ADR-0004）。
 *
 * 放在 sync 下的理由：这一趟的 I/O 是**接口**（Humble 客户端）与落库，和 `runSync` 同类，
 * 但两者**互不调用**——同步管线仍然只取订单列表（ADR-0003 那一半未变，有测试钉住）。
 *
 * 触发时机是硬要求：**页面已经读完并落库之后**才走接口。所以顺序写死为：
 * 1) 先把页面那份落库（`buildPageOrder` → `applyOrderSync`）；
 * 2) 再取一次接口详情，纯合并后走**同一个** `applyOrderSync`。
 *
 * 接口那一趟失败**只降级为「没合并」**：如实写进返回结果，**不抛** ——
 * 否则一次网络抖动会把已经读好的页面数据判成失败（ADR-0004 的边界）。
 */
import {
  type ApiOrderKey,
  isApiSupplementKey,
  mergePageReadWithApiKeys,
} from '../data/page-api-merge'
import { buildPageOrder, type PageOrderRead } from '../data/page-ingest'
import type { LedgerRepository } from '../data/repository'
import type { SyncResult } from '../data/types'

/** 接口那一趟的结果：成功就说清「看到几条 / 几条带码 / 补了几条」，失败就说清原因（都如实记）。 */
export interface PageMergeReport {
  status: 'merged' | 'failed'
  /**
   * 接口这一趟**看到的** key 条数。
   *
   * 为什么必须记：`supplemented: 0` 有三种成因——「页面本来就没缺口」（正常）、
   * 「接口返回空」（可能解析字段名不对）、「接口挂了」（status=failed）。
   * 只看 supplemented 分不清，等于没有证据；记下看到几条，静默失效才藏不住。
   */
  apiKeys: number
  /** 其中**带兑换码**的条数（只有带码才能按码对齐；为 0 说明码字段名可能不对）。 */
  apiCoded: number
  /** 实际补充进台账的 key 条数（页面没有的码）。失败时为 0。 */
  supplemented: number
  /** 失败原因（降级用，不抛）。成功时缺省。 */
  reason?: string
}

/** 一次「页面落库 + 接口合并」的结果。 */
export interface IngestPageResult {
  /** 页面那一份的写入统计——**先落**，所以接口失败也留得住。 */
  write: SyncResult
  /** 接口补充这一趟的结果。 */
  merge: PageMergeReport
}

/** 编排参数。网络取数由调用侧注入，便于单测用假客户端。 */
export interface IngestPageOrderOptions {
  repository: LedgerRepository
  read: PageOrderRead
  /**
   * 接口那一趟：取这一单的 key 列表。
   * 抛错会被本函数**降级吞掉**（页面优先），而不是让整次读取失败。
   */
  fetchApiKeys: (gamekey: string) => Promise<readonly ApiOrderKey[]>
}

/** 页面落库 + 接口补充一次读完。 */
export async function ingestPageOrder(options: IngestPageOrderOptions): Promise<IngestPageResult> {
  const { repository, read } = options

  // 1) **页面先落库**。顺序是有意的：接口那趟无论如何都回退不掉这一份（ADR-0004）。
  const write = repository.applyOrderSync([buildPageOrder(read)])

  // 2) 再取一次接口详情，只用于补充页面没读到的码。
  let apiKeys: readonly ApiOrderKey[]
  try {
    apiKeys = await options.fetchApiKeys(read.orderGamekey)
  } catch (error) {
    return {
      write,
      merge: {
        status: 'failed',
        apiKeys: 0,
        apiCoded: 0,
        supplemented: 0,
        reason: describeError(error),
      },
    }
  }

  // 3) 纯合并（页面优先）后仍走既有落库入口，不另造路径。
  const merged = mergePageReadWithApiKeys(read, apiKeys)
  repository.applyOrderSync([merged])

  const supplemented = merged.bundles.reduce(
    (sum, bundle) => sum + bundle.keys.filter(isApiSupplementKey).length,
    0,
  )
  // 看到几条、其中几条带码，都如实上报：`supplemented` 为 0 时，这两个数字才是「到底有没有缺口」的证据。
  const coded = apiKeys.filter((key) => Boolean(key.code?.trim())).length
  return {
    write,
    merge: { status: 'merged', apiKeys: apiKeys.length, apiCoded: coded, supplemented },
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
