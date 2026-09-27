/**
 * 调试日志的**一行**。
 *
 * 为什么从面板里拆出来：面板管「取数 / 轮询 / 空态」，一行管「一条记录怎么扫」——
 * 两者的改动原因不同（前者跟 IPC 契约走，后者跟可读性走）。
 *
 * 排版约定（日志要「扫」不要「读」）：
 * · 首行固定是元信息：时间 · 类别 · 工具名 · 失败；
 * · 正文分两档：**人话不截断**（agent 的回合文本与最终输出，那才是面板的主要内容），
 *   **机器载荷截断**（工具参数 / 结果、固定模板的 prompt），全量文本挂在 `title` 上悬停可看。
 */
import type { JSX } from 'react'
import type { AgentLogEntry, AgentLogKind } from './types'

/** 类别 → 展示。颜色只是辅助，含义始终由中文标签承载（不只靠颜色传意）。 */
const KIND_VIEW: Record<AgentLogKind, { label: string; badge: string; bar: string }> = {
  run_start: { label: '开始', badge: 'badge-muted', bar: 'border-l-slate-300' },
  turn_text: { label: '文本', badge: 'badge-todo', bar: 'border-l-sky-300' },
  tool: { label: '工具', badge: 'badge-progress', bar: 'border-l-violet-300' },
  run_end: { label: '结束', badge: 'badge-done', bar: 'border-l-emerald-400' },
}

/** 失败统一切红：左侧时间线整条变红 + 淡红底（旁边还有「失败」二字，不靠颜色单独传意）。 */
const FAILED_BAR = 'border-l-red-500 bg-red-50/70'

/** ISO 时间戳只显示到秒：日志只活在本次进程内，日期无意义，面板也窄。 */
function shortTime(at: string): string {
  return at.length >= 19 ? at.slice(11, 19) : at
}

/** 机器载荷（工具参数 / 结果）：等宽 + 截断 + 悬停看全量。 */
function PayloadText({ text }: { text: string }): JSX.Element {
  return (
    <p className="mt-0.5 line-clamp-3 break-all font-mono text-[11px] text-ink-3" title={text}>
      {text}
    </p>
  )
}

/** agent 文本里的一小段：加粗 / 等宽 / 普通，`start` 是它在原文里的起始偏移（当 key 用）。 */
interface InlinePart {
  text: string
  start: number
  bold: boolean
  code: boolean
}

/**
 * 极简行内标记：agent 的输出本来就是 Markdown，原样显示会满屏 `**` 与反引号（真实截图里就是
 * `**阶段一 · 读取并落库**`、`` `https://…` ``）。
 *
 * 只处理最常见的两种：`**加粗**` 与 `` `等宽` ``。**不引 Markdown 依赖**（约束不许加依赖），
 * 也不做完整解析：只按标记切分，切不出来（如落单的 `**`）就原样输出——宁可不好看，也不吃掉原文。
 */
function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  const marker = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let last = 0
  let match = marker.exec(text)
  while (match !== null) {
    if (match.index > last) {
      parts.push({ text: text.slice(last, match.index), start: last, bold: false, code: false })
    }
    const bold = match[1]
    parts.push({
      text: bold ?? match[2] ?? '',
      start: match.index,
      bold: bold !== undefined,
      code: bold === undefined,
    })
    last = match.index + match[0].length
    match = marker.exec(text)
  }
  if (last < text.length)
    parts.push({ text: text.slice(last), start: last, bold: false, code: false })
  return parts
}

/** agent 的文本：不截断，完整排版出来（行内标记渲染成样式）。 */
function ProseText({ text }: { text: string }): JSX.Element {
  return (
    <p className="mt-0.5 whitespace-pre-wrap break-words text-ink-2 text-xs leading-relaxed">
      {inlineParts(text).map((part) => (
        <span
          key={part.start}
          className={
            part.bold ? 'font-semibold text-ink' : part.code ? 'font-mono text-[11px]' : undefined
          }
        >
          {part.text}
        </span>
      ))}
    </p>
  )
}

/** 一条日志记录。 */
export function AgentLogRow({ entry }: { entry: AgentLogEntry }): JSX.Element {
  const view = KIND_VIEW[entry.kind]
  // 只有工具条目与人话两类正文：前者截断（机器载荷），后者展开（要读的内容）。
  const isPayload = entry.kind === 'tool' || entry.kind === 'run_start'

  return (
    <li
      data-testid="ledger-agent-log-item"
      data-kind={entry.kind}
      data-failed={entry.failed}
      className={`border-line border-l-2 py-1 pr-1 pl-2.5 ${entry.failed ? FAILED_BAR : view.bar}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[11px] text-ink-3 tabular-nums">{shortTime(entry.at)}</span>
        <span className={`badge ${view.badge}`}>{view.label}</span>
        {entry.tool && (
          <span className="font-mono font-medium text-indigo-700 text-xs">{entry.tool}</span>
        )}
        {entry.failed && <span className="badge badge-danger">失败</span>}
      </div>

      {entry.detail &&
        (isPayload ? <PayloadText text={entry.detail} /> : <ProseText text={entry.detail} />)}

      {entry.result !== undefined && (
        <p className="mt-0.5 flex gap-1 text-[11px]">
          <span className="text-ink-3" aria-hidden="true">
            →
          </span>
          <span className="line-clamp-3 break-all font-mono text-ink-3" title={entry.result}>
            {entry.result}
          </span>
        </p>
      )}
    </li>
  )
}
