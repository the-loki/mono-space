/**
 * 内置 agent 的调试日志：**纯逻辑**（环形缓冲 + 参数摘要），与 Electron / Pi SDK 解耦。
 *
 * 为什么单独抽出来：面板的价值在于「agent 到底把什么参数传给了工具」，而这段逻辑最容易出边界错
 * （缓冲裁剪、JSON 循环引用、超长参数），做成纯函数才好单测——IPC 层只负责把事件喂进来。
 *
 * 隐私/安全（重要）：工具参数里可能含**密钥明文**（`monospace_keys_ingest` 的 `code`、
 * `ledger_query` 的筛选状态等）。本缓冲**仅存内存、不落盘、不写审计**——应用退出即丢，
 * 也刻意**不接入** `appendAudit`（那是另一条持久化链路，不要混）。
 */
import type { AgentLogEntry, AgentLogKind } from '../../shared/ipc-contract'

/** 记录形状过 IPC（渲染层读 `window.api.agent.log`），所以放在共享契约里。 */
export type { AgentLogEntry, AgentLogKind }

/** 缓冲容量：超过丢最旧。500 足够回看一整次会话，又不至于把内存撑大。 */
export const AGENT_LOG_CAPACITY = 500

/** 参数/结果摘要上限（字符）。一次截图 / 大 DOM 的 base64 参数极大，必须截断。 */
export const AGENT_LOG_SUMMARY_LIMIT = 300

/** 回合文本上限（字符）：比参数宽松，但仍要防超长输出。 */
export const AGENT_LOG_TURN_TEXT_LIMIT = 2000

/** 截断标记（放在末尾，一眼看出「后面还有」）。 */
export const TRUNCATION_MARK = '…'

/**
 * 安全序列化：任何输入都返回字符串，**绝不抛**。
 *
 * 为什么不用裸 `JSON.stringify`：循环引用 / BigInt / 自带 `toJSON` 抛错的参数都会让它抛，
 * 而这条链路跑在事件回调里，抛出去会把整个 agent 运行打断。所以这里兜底降级。
 */
function safeStringify(value: unknown): string {
  if (value === undefined) return ''
  const seen = new WeakSet<object>()
  try {
    const text = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return `${item}n`
      if (typeof item === 'function') return '[Function]'
      if (typeof item === 'object' && item !== null) {
        // replacer 里提前把重复对象换成标记，原生序列化就不会再遇到循环而抛错。
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    })
    // JSON.stringify 对 undefined / 函数返回 undefined，这里统一成字符串。
    return typeof text === 'string' ? text : String(value)
  } catch {
    // 兜底：getter 抛错等仍未覆盖的情况，宁可丢内容也不能崩。
    return '[无法序列化]'
  }
}

/** 超长截断：短文本原样返回，长文本截到 `limit` 并以 `…` 收尾。 */
export function truncate(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  const keep = Math.max(0, limit - TRUNCATION_MARK.length)
  return text.slice(0, keep) + TRUNCATION_MARK
}

/** 参数 → 摘要字符串（JSON + 截断）。非对象、循环引用都安全。 */
export function summarizeArgs(value: unknown, limit: number = AGENT_LOG_SUMMARY_LIMIT): string {
  return truncate(safeStringify(value), limit)
}

/**
 * 追加一条并裁剪到上限（纯函数，返回新数组）。
 *
 * 裁剪策略：**丢最旧的**（保留最新的 `capacity` 条），相对顺序不变。
 * 返回新数组而不是原地改，方便单测断言与快照。
 */
export function appendBounded<T>(
  buffer: readonly T[],
  entry: T,
  capacity: number = AGENT_LOG_CAPACITY,
): T[] {
  const next = [...buffer, entry]
  if (next.length <= capacity) return next
  return next.slice(next.length - capacity)
}

/** 运行开始 / 结束的输入。 */
export interface AgentLogRunEnd {
  ok: boolean
  /** 最终文本（成功）或错误原因（失败）。 */
  detail: string
}

export interface AgentLogToolStart {
  callId: string
  tool: string
  args: unknown
}

export interface AgentLogToolEnd {
  callId: string
  tool: string
  result: unknown
  isError: boolean
}

/** 内存日志缓冲。 */
export interface AgentLogBuffer {
  runStart(prompt: string): void
  runEnd(input: AgentLogRunEnd): void
  pushTextDelta(delta: string): void
  toolStart(input: AgentLogToolStart): void
  toolEnd(input: AgentLogToolEnd): void
  /** 快照：**最新在前**，元素为浅拷贝（外部改不动内部状态）。 */
  snapshot(): AgentLogEntry[]
  /**
   * 是否有一次运行正在进行（`runStart` 之后、`runEnd` 之前）。
   *
   * 为什么单独一个方法而不是让 `snapshot()` 返回 `{ entries, running }`：
   * `snapshot()` 的「最新在前的记录数组」语义被既有测试与面板广泛依赖，改形状只会换来无谓的
   * 断言改动；运行状态与记录本就是两个维度（`clear()` 清记录但不打断运行）。
   */
  isRunning(): boolean
  clear(): void
  size(): number
}

/** 建一个内存缓冲。多实例互不影响（测试友好）。 */
export function createAgentLogBuffer(capacity: number = AGENT_LOG_CAPACITY): AgentLogBuffer {
  let entries: AgentLogEntry[] = []
  let seq = 0
  /** 是否正有一次运行（runStart 置真、runEnd 置假；clear 不动它）。 */
  let running = false
  /** 当前「回合文本」条目：文本增量合并进它，遇到非文本事件就关闭。 */
  let openText: AgentLogEntry | null = null
  /** 正在执行的工具调用：callId → 条目（并行调用也能正确对应）。 */
  const openCalls = new Map<string, AgentLogEntry>()

  function push(draft: Omit<AgentLogEntry, 'seq' | 'at'>): AgentLogEntry {
    const entry: AgentLogEntry = { seq: ++seq, at: new Date().toISOString(), ...draft }
    entries = appendBounded(entries, entry, capacity)
    return entry
  }

  /** 非文本事件（或工具调用）开启新段落：关闭当前回合文本。 */
  function closeText(): void {
    openText = null
  }

  return {
    runStart(prompt) {
      closeText()
      running = true
      push({ kind: 'run_start', detail: truncate(prompt, AGENT_LOG_SUMMARY_LIMIT), failed: false })
    },
    runEnd(input) {
      closeText()
      running = false
      push({
        kind: 'run_end',
        detail: truncate(input.detail, AGENT_LOG_SUMMARY_LIMIT),
        failed: !input.ok,
      })
    },
    pushTextDelta(delta) {
      if (delta.length === 0) return
      // 条目可能已被容量挤掉，先确认它还在数组里。
      if (openText && !entries.includes(openText)) openText = null
      if (!openText) {
        openText = push({ kind: 'turn_text', detail: '', failed: false })
      }
      // 已到上限就不再累加（否则每次都重新截断，白费）。
      if (openText.detail.length >= AGENT_LOG_TURN_TEXT_LIMIT) return
      openText.detail = truncate(openText.detail + delta, AGENT_LOG_TURN_TEXT_LIMIT)
    },
    toolStart(input) {
      closeText()
      const entry = push({
        kind: 'tool',
        tool: input.tool,
        detail: summarizeArgs(input.args),
        failed: false,
      })
      openCalls.set(input.callId, entry)
    },
    toolEnd(input) {
      closeText()
      const entry = openCalls.get(input.callId)
      openCalls.delete(input.callId)
      // 起点条目可能已被容量挤掉：那就补一条独立结果记录，不丢信息。
      if (entry && entries.includes(entry)) {
        entry.failed = input.isError
        entry.result = summarizeArgs(input.result)
        return
      }
      push({
        kind: 'tool',
        tool: input.tool,
        detail: '',
        result: summarizeArgs(input.result),
        failed: input.isError,
      })
    },
    snapshot() {
      // 内部按时间升序，反转成最新在前，方便面板从上往下读。
      return entries.map((entry) => ({ ...entry })).reverse()
    },
    isRunning() {
      return running
    },
    clear() {
      entries = []
      openCalls.clear()
      openText = null
    },
    size() {
      return entries.length
    },
  }
}
