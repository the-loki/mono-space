import { describe, expect, it } from 'vitest'
import { type AxNode, pruneAxTree } from '../ax-tree'

/** 造节点的小工具。 */
function node(id: string, role: string, extra: Partial<AxNode> = {}): AxNode {
  return { nodeId: id, role: { value: role }, ...extra }
}

/** 典型 Humble keys 页形状：根 → 标题 + 若干条目（条目内有按钮）。 */
function humbleLike(): AxNode[] {
  return [
    node('1', 'RootWebArea', { name: { value: 'Your Keys' }, childIds: ['2', '3'] }),
    node('2', 'heading', { name: { value: 'Your Keys' }, childIds: [] }),
    node('3', 'list', {
      childIds: ['4', '6'],
      properties: [{ name: 'level', value: { value: 1 } }],
    }),
    node('4', 'listitem', { name: { value: 'Synty Studios' }, childIds: ['5'] }),
    node('5', 'button', { name: { value: 'Reveal your key' }, childIds: [] }),
    // 噪声节点（generic 无名字）应被剪掉，但要有子节点抬升
    node('6', 'generic', { childIds: ['7'] }),
    node('7', 'listitem', { name: { value: 'Leartes' }, childIds: ['8'] }),
    node('8', 'button', { name: { value: 'Reveal your key' }, childIds: [] }),
  ]
}

describe('剪枝：结构与渲染', () => {
  it('渲染出紧凑缩进文本', () => {
    const result = pruneAxTree(humbleLike())
    expect(result.text).toContain('- RootWebArea "Your Keys"')
    expect(result.text).toContain('  - heading "Your Keys"')
    expect(result.text).toContain('- list level=1')
    expect(result.text).toContain('- listitem "Synty Studios"')
    expect(result.text).toContain('  - button "Reveal your key"')
  })

  it('无名字的 generic 被剪掉，但子节点抬升（不丢内容）', () => {
    const result = pruneAxTree(humbleLike())
    expect(result.text).not.toContain('generic')
    // 抬升后的 Leartes 仍在，且缩进与同级 listitem 一致
    expect(result.text).toContain('    - listitem "Leartes"')
  })

  it('ignored 节点也被抬升而不是丢弃整支', () => {
    const nodes: AxNode[] = [
      node('1', 'RootWebArea', { childIds: ['2'] }),
      node('2', 'generic', { ignored: true, childIds: ['3'] }),
      node('3', 'button', { name: { value: 'Submit' } }),
    ]
    const result = pruneAxTree(nodes)
    expect(result.text).toContain('button "Submit"')
  })

  it('只保留白名单属性，其余丢弃', () => {
    const nodes: AxNode[] = [
      node('1', 'RootWebArea', { childIds: ['2'] }),
      node('2', 'checkbox', {
        name: { value: '同意条款' },
        properties: [
          { name: 'checked', value: { value: true } },
          { name: 'noise', value: { value: 'x' } },
        ],
      }),
    ]
    const result = pruneAxTree(nodes)
    expect(result.text).toContain('checked=true')
    expect(result.text).not.toContain('noise')
  })

  it('value 以 JSON 转义渲染（含引号也不破格式）', () => {
    const nodes: AxNode[] = [
      node('1', 'RootWebArea', { childIds: ['2'] }),
      node('2', 'textbox', { name: { value: '兑换码' }, value: { value: 'AB"C' } }),
    ]
    const result = pruneAxTree(nodes)
    expect(result.text).toContain('= "AB\\"C"')
  })
})

describe('剪枝：预算与截断', () => {
  it('超出节点预算 → 截断并置 truncated', () => {
    const many: AxNode[] = [
      node('1', 'RootWebArea', { childIds: Array.from({ length: 50 }, (_, i) => `c${i + 2}`) }),
    ]
    for (let i = 0; i < 50; i++)
      many.push(node(`c${i + 2}`, 'button', { name: { value: `b${i}` } }))
    const result = pruneAxTree(many, { maxNodes: 10 })
    expect(result.truncated).toBe(true)
    expect(result.nodeCount).toBeLessThanOrEqual(10)
  })

  it('超出字符预算 → 文本被截断并加标记', () => {
    const many: AxNode[] = [
      node('1', 'RootWebArea', { childIds: Array.from({ length: 60 }, (_, i) => `c${i + 2}`) }),
    ]
    for (let i = 0; i < 60; i++) {
      many.push(node(`c${i + 2}`, 'button', { name: { value: `按钮${i}`.repeat(8) } }))
    }
    const result = pruneAxTree(many, { maxChars: 300 })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(300)
    expect(result.text).toContain('截断')
  })

  it('超出深度 → 该支不再展开（防深树爆栈）', () => {
    const chain: AxNode[] = [node('1', 'RootWebArea', { childIds: ['2'] })]
    for (let i = 2; i <= 12; i++)
      chain.push(node(`${i}`, 'group', { name: { value: `g${i}` }, childIds: [`${i + 1}`] }))
    const result = pruneAxTree(chain, { maxDepth: 3 })
    expect(result.text).toContain('g2')
    expect(result.text).not.toContain('g11')
  })

  // 回归（联调踩到）：预算在深处耗尽时，**祖先节点必须保留**，
  // 否则整棵树会变空（表现为 nodeCount=400 但 tree=[]、text=''）。
  it('预算耗尽时保留祖先，只截断深处（不能整棵树变空）', () => {
    const nodes: AxNode[] = [node('1', 'RootWebArea', { name: { value: '根' }, childIds: ['2'] })]
    // 2..60 串成一条链，每层都带名字
    for (let i = 2; i <= 60; i++) {
      nodes.push(node(`${i}`, 'group', { name: { value: `g${i}` }, childIds: [`${i + 1}`] }))
    }
    const result = pruneAxTree(nodes, { maxNodes: 10 })
    expect(result.truncated).toBe(true)
    expect(result.tree.length).toBeGreaterThan(0)
    expect(result.text).toContain('RootWebArea')
    expect(result.text).toContain('g2')
    expect(result.nodeCount).toBeLessThanOrEqual(10)
  })

  it('空树不炸，返回空文本', () => {
    const result = pruneAxTree([])
    expect(result.text).toBe('')
    expect(result.nodeCount).toBe(0)
    expect(result.truncated).toBe(false)
  })
})
