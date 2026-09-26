/**
 * 会话引导的**真实验证**（不是打桩）：建一次真会话，确认
 * 1) 工具真的注入进去了、L2 真的被挡住了；
 * 2) Pi 自带的 read/bash/edit/write 真的没进来；
 * 3) 隔离真的成立（只碰 <userData>/pi-agent，绝不碰 ~/.pi）。
 *
 * 不调 prompt()，所以不联网。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentPaths, writeAgentConfig } from '../config'
import { createEmbeddedAgent, SYSTEM_PROMPT } from '../session'
import type { McpHost } from '../tools'

/** 只在 run() 被调用时才会碰 host，建会话不会；所以这里给个空壳即可。 */
const fakeHost = {} as McpHost

let cleanup: string | undefined

afterEach(async () => {
  if (cleanup) await rm(cleanup, { recursive: true, force: true })
  cleanup = undefined
})

describe('createEmbeddedAgent', () => {
  it('注入 MonoSpace 自己的工具，且挡住不可逆的 L2', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'monospace-agent-'))
    cleanup = userDataDir
    await writeAgentConfig(agentPaths(userDataDir), {
      provider: 'ollama',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:11434',
    })

    const agent = await createEmbeddedAgent({ userDataDir, host: fakeHost })
    try {
      const names = agent.tools.map((tool) => tool.name)

      // 工具表里的 L0/L1 应该都在（浏览器 5 个 + 台账里非 L2 的那些）。
      expect(names).toContain('monospace_dom')
      expect(names).toContain('monospace_act')
      expect(names).toContain('monospace_ledger_stats')

      // 揭示：不再有硬编码工具，但 agent 需要能打开那一单的页面（只开页面、不点击）。
      expect(names).toContain('monospace_key_open')
      expect(names).not.toContain('monospace_key_reveal')

      // 兑换仍是 L2，仍然不给模型。
      expect(names).not.toContain('monospace_key_redeem')

      // Pi 自带工具必须一个都没有（noTools: 'builtin'）。
      for (const builtin of ['read', 'bash', 'edit', 'write', 'ls', 'grep']) {
        expect(names).not.toContain(builtin)
      }

      // 系统提示词是 MonoSpace 自己的那份，没被外部 APPEND_SYSTEM.md 掺进来。
      expect(agent.session.systemPrompt).toContain('MonoSpace')
      expect(agent.session.systemPrompt).toContain('不可逆')
    } finally {
      agent.dispose()
    }
  }, 60_000)

  it('配置不可用时直接抛，并说清原因（不让按钮假装能用）', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'monospace-agent-bad-'))
    cleanup = userDataDir
    await expect(createEmbeddedAgent({ userDataDir, host: fakeHost })).rejects.toThrow(
      /内置 agent 配置不可用/,
    )
  }, 60_000)

  it('隔离：一切路径都在 userData 下，且不含 /.pi', () => {
    const paths = agentPaths('/tmp/whatever-userdata')
    for (const value of Object.values(paths)) {
      if (typeof value !== 'string') continue
      expect(value.startsWith('/tmp/whatever-userdata')).toBe(true)
      expect(value).not.toContain('/.pi')
    }
  })

  it('系统提示词自带作用域说明（当前页面 + 不可逆由人按）', () => {
    expect(SYSTEM_PROMPT).toContain('当前打开的那个页面')
    expect(SYSTEM_PROMPT).toContain('不可逆')
  })

  it('系统提示词明确要求零英文（实测会漏句子，所以写死这条约束）', () => {
    expect(SYSTEM_PROMPT).toContain('一个英文词都不要出现')
    expect(SYSTEM_PROMPT).toContain('不要把思考过程或计划念出来')
  })
})
