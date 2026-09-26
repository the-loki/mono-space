/**
 * CDP 无障碍树（AXTree）→ 紧凑文本（`#13` §3.1 剪枝 / §3.2 预算）。
 *
 * 为什么以 a11y 树为主输入（`#13` §1.1）：它比 DOM 小得多、语义稳定、且天然是
 * 「人看到的东西」。但真实页面（Humble keys 页有几百个 key 条目）会给出上万节点，
 * 所以必须剪枝 + 预算，否则一次工具调用就把上下文撑爆。
 *
 * 纯函数：输入 CDP 原始节点数组，输出稳定文本，便于离线测试与预算断言。
 */

/** CDP `Accessibility.getFullAXTree` 的节点形状（只取我们用到的字段）。 */
export interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  description?: { value?: unknown }
  childIds?: string[]
  properties?: ReadonlyArray<{ name?: string; value?: { value?: unknown } }>
}

export interface PruneOptions {
  /** 最多保留多少节点（含分支节点）。 */
  maxNodes?: number
  /** 渲染文本的字符上限。 */
  maxChars?: number
  /** 最大缩进层级。 */
  maxDepth?: number
  /** 保留的属性名（其余丢弃，避免噪声）。 */
  keepProperties?: readonly string[]
}

export interface PrunedNode {
  role: string
  name?: string
  value?: string
  properties?: Record<string, string>
  children: PrunedNode[]
}

export interface PruneResult {
  /** 剪枝后的树。 */
  tree: PrunedNode[]
  /** 渲染文本（给模型的输入）。 */
  text: string
  /** 保留的节点数。 */
  nodeCount: number
  /** 是否因预算被截断。 */
  truncated: boolean
}

const DEFAULT_MAX_NODES = 400
const DEFAULT_MAX_CHARS = 12_000
const DEFAULT_MAX_DEPTH = 14

const DEFAULT_KEEP_PROPERTIES = ['level', 'checked', 'expanded', 'required', 'selected', 'disabled']

/** 这些角色本身不携带语义，只有在带名字（或值）时才保留。 */
const NOISE_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'StaticText', 'LineBreak'])

function textOf(node: { value?: unknown } | undefined): string | undefined {
  const value = node?.value
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function pickProperties(node: AxNode, keep: readonly string[]): Record<string, string> | undefined {
  if (!node.properties || node.properties.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const property of node.properties) {
    const name = property?.name
    if (!name || !keep.includes(name)) continue
    const raw = property.value?.value
    if (raw === undefined || raw === null || raw === '') continue
    out[name] = typeof raw === 'string' ? raw : String(raw)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

interface Built {
  node: PrunedNode
  childIds: string[]
}

/** 把 CDP 节点数组剪成一棵树（忽略节点会被「抬升」，子节点接到父级）。 */
function buildTree(
  nodes: readonly AxNode[],
  options: Required<PruneOptions>,
): {
  tree: PrunedNode[]
  nodeCount: number
  truncated: boolean
} {
  const byId = new Map<string, AxNode>()
  for (const node of nodes) byId.set(node.nodeId, node)

  let nodeCount = 0
  let truncated = false

  /** 返回该节点（跳过时返回其子节点的合成列表）。 */
  function build(node: AxNode, depth: number): PrunedNode[] {
    if (truncated) return []
    if (depth > options.maxDepth) return []

    const role = textOf(node.role) ?? 'unknown'
    const name = textOf(node.name)
    const value = textOf(node.value)

    const isNoise = NOISE_ROLES.has(role)
    const keepSelf = !node.ignored && (!isNoise || Boolean(name) || Boolean(value))

    if (!keepSelf) {
      // 忽略/噪声节点：自身不留，子节点抬升（抬升不消耗自身预算）。
      const hoisted: PrunedNode[] = []
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId)
        if (child) hoisted.push(...build(child, depth + 1))
      }
      return hoisted
    }

    // ⚠️ **先序消耗预算**：先为自己占位，再展开孩子。
    // 若改成「先递归孩子、后判自己」，预算在深处耗尽后会**连祖先一起丢掉**，
    // 整棵树直接变空（真实密钥页 400+ 节点时联调踩到）。
    if (nodeCount >= options.maxNodes) {
      truncated = true
      return []
    }
    nodeCount += 1

    const children: PrunedNode[] = []
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (!child) continue
      children.push(...build(child, depth + 1))
    }

    const pruned: PrunedNode = { role, children }
    if (name) pruned.name = name
    if (value) pruned.value = value
    const properties = pickProperties(node, options.keepProperties)
    if (properties) pruned.properties = properties
    return [pruned]
  }

  const tree: PrunedNode[] = []
  // 只从**真正的根**开始：被别的节点引用为子节点的，不再当根，
  // 否则同一支会被重复渲染（且深度/节点预算都会失真）。
  const childIds = new Set<string>()
  for (const node of nodes) {
    for (const id of node.childIds ?? []) childIds.add(id)
  }
  const roots = nodes.filter((node) => !childIds.has(node.nodeId))
  const startFrom = roots.length > 0 ? roots : nodes.slice(0, 1)

  for (const node of startFrom) {
    if (truncated) break
    tree.push(...build(node, 0))
  }
  return { tree, nodeCount, truncated }
}

function render(nodes: readonly PrunedNode[], indent: string, lines: string[]): void {
  for (const node of nodes) {
    const parts = [`${indent}- ${node.role}`]
    if (node.name) parts.push(`"${node.name}"`)
    if (node.value) parts.push(`= ${JSON.stringify(node.value)}`)
    if (node.properties) {
      for (const [key, value] of Object.entries(node.properties)) parts.push(`${key}=${value}`)
    }
    lines.push(parts.join(' '))
    render(node.children, `${indent}  `, lines)
  }
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const marker = '\n…（已按预算截断）'
  return { text: text.slice(0, Math.max(0, maxChars - marker.length)) + marker, truncated: true }
}

/** 主入口：CDP 节点数组 → 剪枝树 + 渲染文本。 */
export function pruneAxTree(nodes: readonly AxNode[], options: PruneOptions = {}): PruneResult {
  const resolved: Required<PruneOptions> = {
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    keepProperties: options.keepProperties ?? DEFAULT_KEEP_PROPERTIES,
  }

  const built = buildTree(nodes, resolved)
  const lines: string[] = []
  render(built.tree, '', lines)
  const raw = lines.join('\n')
  const clipped = truncateText(raw, resolved.maxChars)

  return {
    tree: built.tree,
    text: clipped.text,
    nodeCount: built.nodeCount,
    truncated: built.truncated || clipped.truncated,
  }
}
