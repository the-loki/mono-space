/**
 * MonoSpace 的 MCP 服务端（`#31`）。
 *
 * 形态：**进程内 HTTP（streamable）服务，只绑 `127.0.0.1`**，随机端口 + 每次启动生成的 token。
 *
 * 为什么在 App 内跑而不是 stdio：
 * 内置浏览器的登录态在应用的 `persist:store` 分区里，只有 App 能碰；台账也是 App 独占。
 * 所以 App 当服务端、外部 agent 当客户端，是对的切分——也因此 App **不需要**配置任何模型与 key。
 *
 * 安全：token 由 URL query 传入，比对用常量时间比较；只监听回环地址。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpTools, type McpHost } from './tools'

export const MCP_SERVER_NAME = 'monospace'
export const MCP_SERVER_VERSION = '0.1.0'

/**
 * 固定端口：让使用者的 MCP 客户端**配置一次**就长期可用（每次随机端口会导致失联）。
 * 可用 `MONOSPACE_MCP_PORT` 覆盖。
 */
export const DEFAULT_MCP_PORT = 37421

export interface McpServerOptions {
  host: McpHost
  /** 应用私有目录（写 endpoint 描述文件用）。 */
  userDataDir: string
  /** 指定端口便于复现；默认随机。 */
  port?: number
}

export interface McpEndpoint {
  /** 完整 URL（含 token），外部 agent 用它连接。 */
  url: string
  port: number
  token: string
  /** 写在哪（供人查看）。 */
  file: string
}

export interface RunningMcpServer {
  endpoint: McpEndpoint
  close(): Promise<void>
}

/** 生成一次性 token。 */
function newToken(): string {
  return randomBytes(24).toString('hex')
}

/**
 * 取（或首次生成并落盘）服务 token。
 *
 * 落盘为 0600 的应用私有文件：客户端配置因此可长期复用，而不必每次启动重新抄 token。
 * 仍然只监听回环地址，token 的作用是挡住**本机其它进程/网页**随意驱动这个带登录态的浏览器。
 */
export async function loadOrCreateToken(userDataDir: string): Promise<string> {
  const file = join(userDataDir, 'mcp-token')
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing.length >= 32) return existing
  } catch {
    // 首次运行
  }
  const token = newToken()
  await writeFile(file, token, { encoding: 'utf8', mode: 0o600 })
  return token
}

/** 常量时间比较，避免 token 早退泄漏长度信息。 */
export function tokenMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 从 URL 里取 token（`?token=…`，兼容 `Authorization: Bearer`）。 */
export function extractToken(url: string, authorization?: string): string | null {
  try {
    const parsed = new URL(url, 'http://127.0.0.1')
    const fromQuery = parsed.searchParams.get('token')
    if (fromQuery) return fromQuery
  } catch {
    // 落到 header
  }
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim() || null
  return null
}

/** 读 JSON 请求体。 */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/** 建 McpServer 并注册全部 `monospace_*` 工具。 */
export function buildMcpServer(host: McpHost): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION })

  for (const tool of createMcpTools(host)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (input: Record<string, unknown>) => {
        try {
          const result = await tool.run(input ?? {})
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          }
        } catch (error) {
          // 工具失败要如实回给 agent（不吞、不伪装成功）。
          const message = error instanceof Error ? error.message : String(error)
          return {
            content: [
              { type: 'text' as const, text: `MonoSpace 工具失败（${tool.name}）：${message}` },
            ],
            isError: true,
          }
        }
      },
    )
  }

  return server
}

/**
 * 启动 MCP 服务。
 *
 * 每个会话一个 transport（streamable 的有状态模式），并复用同一个 McpServer——
 * 单用户本地场景够用，也避免多会话状态污染。
 */
export async function startMcpServer(options: McpServerOptions): Promise<RunningMcpServer> {
  const token = await loadOrCreateToken(options.userDataDir)
  const server = buildMcpServer(options.host)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomBytes(16).toString('hex'),
  })
  await server.connect(transport)

  const httpServer: Server = createServer((request, response) => {
    void (async () => {
      const provided = extractToken(
        request.url ?? '/',
        request.headers.authorization as string | undefined,
      )
      if (!tokenMatches(token, provided)) {
        sendJson(response, 401, { error: 'MonoSpace MCP：缺少或错误的 token' })
        return
      }

      if (request.method === 'GET' && (request.url ?? '').startsWith('/health')) {
        sendJson(response, 200, {
          ok: true,
          server: MCP_SERVER_NAME,
          tools: createMcpTools(options.host).length,
        })
        return
      }

      const body = await readBody(request)
      await transport.handleRequest(request, response, body)
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  })

  const wantPort =
    options.port ??
    (process.env.MONOSPACE_MCP_PORT ? Number(process.env.MONOSPACE_MCP_PORT) : DEFAULT_MCP_PORT)

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', (error: NodeJS.ErrnoException) => {
      // 端口被占：退回随机端口，但明确报出来（不静默换端口让使用者困惑）。
      if (error.code === 'EADDRINUSE') {
        console.error(`MonoSpace MCP：端口 ${wantPort} 被占用，改用随机端口`)
        httpServer.listen(0, '127.0.0.1', () => {
          const address = httpServer.address()
          if (address && typeof address === 'object') resolve(address.port)
          else reject(error)
        })
        return
      }
      reject(error)
    })
    httpServer.listen(wantPort, '127.0.0.1', () => {
      const address = httpServer.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('无法确定 MCP 端口'))
    })
  })

  const url = `http://127.0.0.1:${port}/mcp?token=${token}`
  const file = join(options.userDataDir, 'mcp-endpoint.json')
  await writeFile(file, JSON.stringify({ url, port, server: MCP_SERVER_NAME }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })

  return {
    endpoint: { url, port, token, file },
    close: async () => {
      await server.close().catch(() => {})
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}
