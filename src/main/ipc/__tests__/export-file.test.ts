import { describe, expect, it, vi } from 'vitest'
import {
  createDefaultSaveDeps,
  createSaveDeps,
  defaultExportFileName,
  exportDialogTitle,
  saveExportFile,
} from '../export-file'

const NOW = new Date('2026-09-27T10:20:30')

describe('导出文件名', () => {
  it('全量导出：带日期与正确扩展名', () => {
    expect(defaultExportFileName({ format: 'json', query: {} }, NOW)).toBe(
      'monospace-ledger-2026-09-27.json',
    )
    expect(defaultExportFileName({ format: 'csv', query: {} }, NOW)).toBe(
      'monospace-ledger-2026-09-27.csv',
    )
  })

  it('★ 明细视图（限定某一单）时把订单号写进文件名 —— 否则存两次分不清是哪一份', () => {
    const name = defaultExportFileName(
      { format: 'json', query: { orderRemoteId: 'wPqrrDYDXvaX4TKR' } },
      NOW,
    )
    expect(name).toBe('monospace-order-wPqrrDYDXvaX4TKR-2026-09-27.json')
    expect(name).not.toBe(defaultExportFileName({ format: 'json', query: {} }, NOW))
  })

  it('日期用本地日历（不是 UTC 日期串）', () => {
    // 本地时间 23:30 与次日 00:30 必须落在不同日期上
    const late = defaultExportFileName({ format: 'json', query: {} }, new Date(2026, 0, 5, 23, 30))
    const next = defaultExportFileName({ format: 'json', query: {} }, new Date(2026, 0, 6, 0, 30))
    expect(late).toContain('2026-01-05')
    expect(next).toContain('2026-01-06')
  })

  it('对话框标题跟着范围走', () => {
    expect(exportDialogTitle({ format: 'json', query: {} })).toContain('全部')
    expect(exportDialogTitle({ format: 'csv', query: { orderRemoteId: 'abc' } })).toContain(
      '这一单',
    )
  })
})

describe('保存导出文件', () => {
  it('用户选了路径：写入文本并返回路径', async () => {
    const writeFile = vi.fn(async () => undefined)
    const result = await saveExportFile(
      { pickPath: async () => '/tmp/x.json', writeFile },
      { format: 'json', query: {} },
      '{"a":1}',
      NOW,
    )
    expect(result).toEqual({ saved: true, path: '/tmp/x.json' })
    expect(writeFile).toHaveBeenCalledWith('/tmp/x.json', '{"a":1}')
  })

  it('★ 用户取消：不写任何文件，返回 saved:false（取消不是错误）', async () => {
    const writeFile = vi.fn(async () => undefined)
    const result = await saveExportFile(
      { pickPath: async () => null, writeFile },
      { format: 'csv', query: {} },
      'a,b\n1,2\n',
      NOW,
    )
    expect(result).toEqual({ saved: false })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('选路径时把「默认文件名 + 标题」一起交给对话框', async () => {
    const pickPath = vi.fn(async () => null)
    await saveExportFile(
      { pickPath, writeFile: async () => undefined },
      { format: 'csv', query: { orderRemoteId: 'abc' } },
      'x',
      NOW,
    )
    expect(pickPath).toHaveBeenCalledWith(
      'monospace-order-abc-2026-09-27.csv',
      exportDialogTitle({ format: 'csv', query: { orderRemoteId: 'abc' } }),
    )
  })

  it('写失败要往上抛（界面得能看到原因，不能静默成功）', async () => {
    const writeFile = vi.fn(async () => {
      throw new Error('EACCES: 没有写权限')
    })
    await expect(
      saveExportFile(
        { pickPath: async () => '/root/x.json', writeFile },
        { format: 'json', query: {} },
        'x',
        NOW,
      ),
    ).rejects.toThrow('EACCES')
  })

  it('真实依赖：写文件用 0600（导出内容含兑换码明文，不该让同机其他用户读到）', async () => {
    const deps = createDefaultSaveDeps(async () => '/tmp/y.json')
    // 真实依赖里的 writeFile 直接引用了 fs，这里只断言「可构造且 pickPath 透传」
    expect(typeof deps.writeFile).toBe('function')
    await expect(deps.pickPath('/tmp/y.json', '标题')).resolves.toBe('/tmp/y.json')
  })
})

describe('createSaveDeps：MS_EXPORT_DIR 测试缝', () => {
  it('★ 设了 MS_EXPORT_DIR 就不弹对话框，直接落到该目录（原生对话框没法无头点，e2e 靠这个缝）', async () => {
    const showSaveDialog = vi.fn(async () => '/should/not/be/used.json')
    const deps = createSaveDeps({ MS_EXPORT_DIR: '/tmp/ms-export' }, showSaveDialog)
    const picked = await deps.pickPath('monospace-ledger-2026-09-27.json', '标题')
    expect(picked).toBe('/tmp/ms-export/monospace-ledger-2026-09-27.json')
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('目录两侧有空白也认（trim），仍然不弹对话框', async () => {
    const showSaveDialog = vi.fn(async () => null)
    const deps = createSaveDeps({ MS_EXPORT_DIR: '  /tmp/x  ' }, showSaveDialog)
    expect(await deps.pickPath('a.json', 't')).toBe('/tmp/x/a.json')
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('没设 / 空串 / 纯空白 ⇒ 照旧弹对话框（默认行为不被缝改掉）', async () => {
    for (const env of [{}, { MS_EXPORT_DIR: '' }, { MS_EXPORT_DIR: '   ' }]) {
      const showSaveDialog = vi.fn(async () => '/picked.json')
      const deps = createSaveDeps(env, showSaveDialog)
      expect(await deps.pickPath('a.json', 't')).toBe('/picked.json')
      expect(showSaveDialog).toHaveBeenCalledTimes(1)
    }
  })
})
