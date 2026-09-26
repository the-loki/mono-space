/**
 * 性能录制（对齐 Chrome MCP 的 `performance_start_trace` / `performance_stop_trace`）。
 *
 * 走 CDP 的 `Tracing` 域：这是 Chrome DevTools 自己用的录制通道，拿到的是真实
 * trace 事件流，而不是页面脚本上报的近似值。
 *
 * 说明：Chrome MCP 还有 `performance_analyze_insight`（对 trace 做洞察分析），
 * 那依赖上游一整套 insight 引擎，本期**未**实现——不注册比假装有更诚实。
 */
import { writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import type { BrowserWindow } from 'electron'
import { cdpSend, ensureDomain } from './cdp'

/** 与 DevTools Performance 面板等价的类别集。 */
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'blink.user_timing',
  'v8.execute',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.invalidationTracking',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-devtools.screenshot',
].join(',')

interface ActiveTrace {
  chunks: string[]
  done: Promise<void>
  /** 已经 stop 过，防止重复收尾。 */
  stopped: boolean
}

const active = new WeakMap<BrowserWindow, ActiveTrace>()

export interface StartTraceOptions {
  reload?: boolean
  filePath?: string
}

/** 开始录制。`reload` 时立刻刷新页面，让 trace 覆盖一次完整加载。 */
export async function startTrace(
  window: BrowserWindow,
  options: StartTraceOptions = {},
): Promise<{ started: true; categories: string }> {
  if (active.has(window)) throw new Error('该页面已经在录制性能 trace 了')

  await ensureDomain(window, 'Tracing')
  const debuggerApi = window.webContents.debugger
  const chunks: string[] = []

  let resolveDone = (): void => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const onMessage = (_event: unknown, method: string, params?: { data?: string }): void => {
    if (method === 'Tracing.dataCollected' && typeof params?.data === 'string') {
      chunks.push(params.data)
      return
    }
    if (method === 'Tracing.tracingComplete') {
      debuggerApi.removeListener('message', onMessage as never)
      resolveDone()
    }
  }
  debuggerApi.on('message', onMessage as never)

  const trace: ActiveTrace = { chunks, done, stopped: false }
  active.set(window, trace)

  try {
    await cdpSend(window, 'Tracing.start', {
      categories: TRACE_CATEGORIES,
      options: 'sampling-frequency=10000',
      transferMode: 'ReportEvents',
    })
  } catch (error) {
    debuggerApi.removeListener('message', onMessage as never)
    active.delete(window)
    throw error
  }

  if (options.reload) window.webContents.reload()
  return { started: true, categories: TRACE_CATEGORIES }
}

export interface StopTraceOptions {
  filePath?: string
  /** 未给 filePath 时的兜底落盘目录（通常是 userData/mcp-artifacts）。 */
  fallbackDir?: string
}

/** 停止录制，收拢事件流并按需落盘（`.json.gz` 就压缩）。 */
export async function stopTrace(
  window: BrowserWindow,
  options: StopTraceOptions = {},
): Promise<{ path: string; events: number; bytes: number }> {
  const trace = active.get(window)
  if (!trace) throw new Error('该页面当前没有在录制性能 trace')
  if (trace.stopped) throw new Error('该页面的 trace 已经停止过了')

  await ensureDomain(window, 'Tracing')
  await cdpSend(window, 'Tracing.end')
  await trace.done
  trace.stopped = true
  active.delete(window)

  const raw = `[${trace.chunks.join(',')}]`
  const events = trace.chunks.length === 0 ? 0 : JSON.parse(raw).length
  const directory = options.fallbackDir
  if (!options.filePath && !directory) throw new Error('需要 filePath 或 fallbackDir 之一')
  const path = options.filePath ?? `${directory}/trace-${Date.now()}.json`

  const payload: string | Uint8Array = path.endsWith('.gz')
    ? gzipSync(Buffer.from(raw, 'utf8'))
    : raw
  await writeFile(path, payload)
  return { path, events, bytes: payload.length }
}

/** 该页面是否正在录制。 */
export function isTracing(window: BrowserWindow): boolean {
  return active.has(window)
}
