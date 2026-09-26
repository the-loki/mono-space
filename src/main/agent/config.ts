/**
 * 内置 agent 的配置（用户决策：**自己的配置，与外部 pi 完全隔离、互不影响**）。
 *
 * 隔离靠 Pi 的 `agentDir`（默认 `~/.pi/agent`）——把它指到 `<userData>/pi-agent/`，
 * 认证、模型、设置、扩展发现就全部落在 MonoSpace 自己的目录里，
 * **绝不读写 `~/.pi`**（那里的扩展/mcp.json/models.json 都碰不到）。
 *
 * 本文件不 import electron，便于离线测试。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** MonoSpace 自己的 agent 目录名（放在 userData 下）。 */
export const AGENT_DIR_NAME = 'pi-agent'

export interface AgentPaths {
  /** 传给 createAgentSession 的 `agentDir`（隔离开关）。 */
  agentDir: string
  modelsFile: string
  authFile: string
}

/** 由 userData 推出我们自己的 agent 路径（**永远不指向 `~/.pi`**）。 */
export function agentPaths(userDataDir: string): AgentPaths {
  const agentDir = join(userDataDir, AGENT_DIR_NAME)
  return {
    agentDir,
    modelsFile: join(agentDir, 'models.json'),
    authFile: join(agentDir, 'auth.json'),
  }
}

export interface AgentModelConfig {
  provider: string
  model: string
  apiKey: string
  baseUrl?: string
  /** 协议；缺省 `anthropic-messages`（与本机参照配置一致）。 */
  api?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
}

export type ParseAgentConfig =
  | { ok: true; config: AgentModelConfig }
  | { ok: false; reason: string }

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 校验并归一配置；缺关键字段时给出**能照着改**的原因（而不是让 Pi 启动时才报怪错）。 */
export function parseAgentConfig(raw: unknown): ParseAgentConfig {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: '配置不是对象' }
  }
  const record = raw as Record<string, unknown>
  const provider = nonEmptyString(record.provider)
  const model = nonEmptyString(record.model)
  const apiKey = nonEmptyString(record.apiKey)
  if (!provider) return { ok: false, reason: '缺少 provider' }
  if (!model) return { ok: false, reason: '缺少 model' }
  if (!apiKey) return { ok: false, reason: '缺少 apiKey' }

  const config: AgentModelConfig = { provider, model, apiKey }
  const baseUrl = nonEmptyString(record.baseUrl)
  if (baseUrl) config.baseUrl = baseUrl
  const api = nonEmptyString(record.api)
  if (api) config.api = api
  const contextWindow = Number(record.contextWindow)
  if (Number.isFinite(contextWindow) && contextWindow > 0) config.contextWindow = contextWindow
  const maxTokens = Number(record.maxTokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) config.maxTokens = maxTokens
  if (typeof record.reasoning === 'boolean') config.reasoning = record.reasoning
  return { ok: true, config }
}

/**
 * 生成 Pi 期望的 `models.json` 形状（参照本机 `~/.pi/agent/models.json`）：
 * `{ providers: { <name>: { api, apiKey, authHeader, baseUrl, models: [{ id, ... }] } } }`
 */
export function buildModelsJson(config: AgentModelConfig): Record<string, unknown> {
  const modelEntry: Record<string, unknown> = { id: config.model, _launch: true }
  if (config.contextWindow) modelEntry.contextWindow = config.contextWindow
  if (config.maxTokens) modelEntry.maxTokens = config.maxTokens
  if (config.reasoning !== undefined) modelEntry.reasoning = config.reasoning

  const provider: Record<string, unknown> = {
    api: config.api ?? 'anthropic-messages',
    apiKey: config.apiKey,
    authHeader: true,
    models: [modelEntry],
  }
  if (config.baseUrl) provider.baseUrl = config.baseUrl

  return { providers: { [config.provider]: provider } }
}

/**
 * 从 Pi 形状的 `models.json` 反解回扁平配置。
 *
 * ⚠️ 必须有它：`writeAgentConfig` 落盘是 **Pi 形状**，直接拿 `parseAgentConfig` 去读会
 * 永远失败（往返不一致）——这是测试当场抓到的 bug。
 * 取第一个 provider 的第一个 model。
 */
export function parseModelsJson(raw: unknown): ParseAgentConfig {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: '配置不是对象' }
  const providers = (raw as Record<string, unknown>).providers
  if (typeof providers !== 'object' || providers === null) {
    return { ok: false, reason: '缺少 providers' }
  }
  const entries = Object.entries(providers as Record<string, unknown>)
  const first = entries[0]
  if (!first) return { ok: false, reason: 'providers 为空' }
  const [name, providerRaw] = first
  if (typeof providerRaw !== 'object' || providerRaw === null) {
    return { ok: false, reason: `provider ${name} 不是对象` }
  }
  const provider = providerRaw as Record<string, unknown>
  const models = Array.isArray(provider.models) ? provider.models : []
  const firstModel = models[0]
  const modelId =
    typeof firstModel === 'object' && firstModel !== null
      ? (firstModel as Record<string, unknown>).id
      : undefined

  return parseAgentConfig({
    provider: name,
    model: modelId,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    api: provider.api,
    contextWindow:
      typeof firstModel === 'object' && firstModel !== null
        ? (firstModel as Record<string, unknown>).contextWindow
        : undefined,
    maxTokens:
      typeof firstModel === 'object' && firstModel !== null
        ? (firstModel as Record<string, unknown>).maxTokens
        : undefined,
    reasoning:
      typeof firstModel === 'object' && firstModel !== null
        ? (firstModel as Record<string, unknown>).reasoning
        : undefined,
  })
}

/** 读配置；文件不存在或非法时返回原因（调用方决定是提示用户还是走默认）。 */
export async function readAgentConfig(
  paths: AgentPaths,
): Promise<ParseAgentConfig & { exists: boolean }> {
  try {
    const text = await readFile(paths.modelsFile, 'utf8')
    return { ...parseModelsJson(JSON.parse(text)), exists: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: false, reason: '还没有配置（请填写模型与 apiKey）', exists: false }
    }
    return { ok: false, reason: `配置不可读/不是合法 JSON：${String(error)}`, exists: true }
  }
}

/** 落盘配置：目录 0700、文件 0600（里面是 API key 明文，权限必须收紧）。 */
export async function writeAgentConfig(paths: AgentPaths, config: AgentModelConfig): Promise<void> {
  await mkdir(paths.agentDir, { recursive: true, mode: 0o700 })
  await writeFile(paths.modelsFile, `${JSON.stringify(buildModelsJson(config), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  // Pi 期望 auth.json 存在；凭据已在 models.json 的 apiKey 里，这里给空对象即可。
  await writeFile(paths.authFile, '{}\n', { encoding: 'utf8', mode: 0o600 })
}
