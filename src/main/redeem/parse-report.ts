/**
 * 扩展回执 → 状态机输入（规格 #12 §6.1）。
 *
 * 扩展在页面里观测，把结构化回执 postMessage 出来；这里把它翻译成 `SubmitOutcome`。
 * **拿不准就交人工**：识别不出结果区的页面一律 needs_human，绝不猜成功。
 */
import type { SubmitOutcome } from './flow'

/** 扩展上报的页面形态。 */
export type ReportPage = 'redeem' | 'library' | 'login' | 'captcha' | 'unknown'

export interface ExtensionReport {
  page: ReportPage
  /** 页面上读到的错误码（Epic 的 `errors.com.epicgames.*`，有则给全码）。 */
  errorCode?: string | null
  /** 页面文案（兜底）。 */
  message?: string | null
  /** 结果区是否明确显示成功。 */
  success?: boolean
  /** `page === 'library'` 时的 listing 标题列表。 */
  listingTitles?: string[]
}

export function toSubmitOutcome(report: ExtensionReport): SubmitOutcome {
  switch (report.page) {
    case 'login':
      return { page: 'logged-out' }
    case 'captcha':
      return { page: 'captcha' }
    case 'unknown':
      return { page: 'unknown', message: report.message ?? '页面不可识别' }
    case 'library':
      // 库页本身不是兑换结果页——走到这里说明流程串了，交人工。
      return { page: 'unknown', message: '意外停在了库页' }
    default:
      if (report.success === true) {
        return { page: 'success', message: report.message ?? '页面显示成功' }
      }
      if (report.errorCode || report.message) {
        return { page: 'error', code: report.errorCode ?? null, message: report.message ?? null }
      }
      // 结果区既没成功也没错误码 → 不猜。
      return { page: 'human', message: '页面未给出可识别的结果' }
  }
}
