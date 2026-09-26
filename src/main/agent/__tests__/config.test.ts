import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_DIR_NAME,
  agentPaths,
  buildModelsJson,
  parseAgentConfig,
  parseModelsJson,
  readAgentConfig,
  writeAgentConfig,
} from '../config'

const USER_DATA = '/home/someone/.config/mono-space'

describe('路径隔离（用户要求：与外部 pi 互不影响）', () => {
  it('agentDir 落在 MonoSpace 的 userData 下', () => {
    expect(agentPaths(USER_DATA).agentDir).toBe(join(USER_DATA, AGENT_DIR_NAME))
  })

  it('绝不指向 ~/.pi —— 否则会读到外部 pi 的配置与扩展', () => {
    const p = agentPaths(USER_DATA)
    for (const path of [p.agentDir, p.modelsFile, p.authFile]) {
      expect(path).not.toContain('/.pi')
      expect(path.startsWith(USER_DATA)).toBe(true)
    }
  })
})

describe('配置校验', () => {
  it('缺 provider / model / apiKey 时给出能照着改的原因', () => {
    expect(parseAgentConfig({ model: 'm', apiKey: 'k' })).toMatchObject({
      ok: false,
      reason: '缺少 provider',
    })
    expect(parseAgentConfig({ provider: 'p', apiKey: 'k' })).toMatchObject({
      ok: false,
      reason: '缺少 model',
    })
    expect(parseAgentConfig({ provider: 'p', model: 'm' })).toMatchObject({
      ok: false,
      reason: '缺少 apiKey',
    })
  })

  it('空白字符串也算缺（避免填了空格就当配好）', () => {
    expect(parseAgentConfig({ provider: '  ', model: 'm', apiKey: 'k' })).toMatchObject({
      ok: false,
    })
  })

  it('非对象输入不崩', () => {
    expect(parseAgentConfig(null)).toMatchObject({ ok: false })
    expect(parseAgentConfig('x')).toMatchObject({ ok: false })
  })

  it('合法配置归一化并可选用字段', () => {
    const parsed = parseAgentConfig({
      provider: 'ollama',
      model: 'deepseek-v4.1-flash:cloud',
      apiKey: 'k',
      baseUrl: 'https://ollama.com',
      contextWindow: 400000,
      reasoning: true,
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.config.baseUrl).toBe('https://ollama.com')
      expect(parsed.config.contextWindow).toBe(400000)
      expect(parsed.config.reasoning).toBe(true)
    }
  })
})

describe('models.json 形状（照本机参照配置）', () => {
  it('providers.<name>.{api,apiKey,authHeader,baseUrl,models[]}', () => {
    const json = buildModelsJson({
      provider: 'ollama',
      model: 'm1',
      apiKey: 'secret',
      baseUrl: 'https://ollama.com',
    }) as { providers: Record<string, Record<string, unknown>> }
    const provider = json.providers.ollama as Record<string, unknown>
    expect(provider.api).toBe('anthropic-messages')
    expect(provider.apiKey).toBe('secret')
    expect(provider.authHeader).toBe(true)
    expect(provider.baseUrl).toBe('https://ollama.com')
    expect(provider.models).toEqual([{ id: 'm1', _launch: true }])
  })

  it('input 模态要落盘且能读回（截图靠它，丢了就看不了图）', async () => {
    const json = buildModelsJson({
      provider: 'ollama',
      model: 'm1',
      apiKey: 'k',
      input: ['text', 'image'],
    })
    const providers = json.providers as Record<string, { models: { input?: string[] }[] }>
    expect(providers.ollama.models[0].input).toEqual(['text', 'image'])
    expect(parseModelsJson(json)).toMatchObject({ ok: true })
    const parsed = parseModelsJson(json)
    expect(parsed.ok && parsed.config.input).toEqual(['text', 'image'])
  })

  it('Pi 形状能反解回扁平配置（往返一致）', () => {
    const json = buildModelsJson({
      provider: 'ollama',
      model: 'm1',
      apiKey: 'secret',
      baseUrl: 'https://ollama.com',
      contextWindow: 400000,
    })
    const parsed = parseModelsJson(json)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.config).toMatchObject({
        provider: 'ollama',
        model: 'm1',
        apiKey: 'secret',
        baseUrl: 'https://ollama.com',
      })
    }
  })

  it('反解残缺形状时如实报原因', () => {
    expect(parseModelsJson({})).toMatchObject({ ok: false, reason: '缺少 providers' })
    expect(parseModelsJson({ providers: {} })).toMatchObject({
      ok: false,
      reason: 'providers 为空',
    })
  })

  it('没给 baseUrl 就不写该键（别塞 undefined）', () => {
    const json = buildModelsJson({ provider: 'p', model: 'm', apiKey: 'k' }) as {
      providers: Record<string, Record<string, unknown>>
    }
    expect('baseUrl' in json.providers.p!).toBe(false)
  })
})

describe('落盘', () => {
  it('写入后能读回，且权限是 0600（里面是明文 key）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-agent-'))
    const paths = agentPaths(dir)
    await writeAgentConfig(paths, { provider: 'ollama', model: 'm', apiKey: 'k' })

    const mode = (await stat(paths.modelsFile)).mode & 0o777
    expect(mode).toBe(0o600)

    const read = await readAgentConfig(paths)
    expect(read.ok).toBe(true)
    expect(read.exists).toBe(true)
    if (read.ok) expect(read.config.model).toBe('m')
    expect(JSON.parse(await readFile(paths.authFile, 'utf8'))).toEqual({})
  })

  it('没配过时如实说「还没有配置」，而不是报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-agent-empty-'))
    const read = await readAgentConfig(agentPaths(dir))
    expect(read).toMatchObject({ ok: false, exists: false })
  })
})
