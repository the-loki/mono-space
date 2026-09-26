/**
 * CDP 无障碍树（AXTree）→ 紧凑文本（`#13` §3.1 剪枝 / §3.2 预算）。
 *
 * 为什么以 a11y 树为主输入（`#13` §1.1）：它比 DOM 小得多、语义稳定、且天然是
 * 「人看到的东西」。但真实页面（Humble keys 页有几百个 key 条目）会给出上万节点，
 * 所以必须剪枝 + 预算，否则一次工具调用就把上下文撑爆。
 *
 * 输出格式**照 Chrome MCP 的 `take_snapshot`**：每个节点一行、`uid=N_i` 引用、
 * 行内属性、按深度缩进。agent 拿 `uid` 去调 click/fill，而不是自己猜 CSS 选择器。
 * 但**不给 `evaluate_script`**——这是与 Chrome MCP 的关键差别（`#13` 红线）。
 *
 * 纯函数：输入 CDP 原始节点数组，输出稳定文本 + 引用表，便于离线测试与预算断言。
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
  /** 反向指回 DOM 的节点号；动作层靠它定位（`DOM.getBoxModel` 接受此参数）。 */
  backendDOMNodeId?: number
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
  /** `uid` 前缀（通常是一次快照的序号），生成形如 `uid=3_7` 的引用。 */
  uidPrefix?: number
}

/** 可交互元素引用：快照给 agent 的「手柄」。 */
export interface AxRef {
  uid: string
  backendDOMNodeId: number
  role: string
  name?: string
}

export interface PrunedNode {
  role: string
  name?: string
  value?: string
  properties?: Record<string, string>
  /** 该节点在本次快照里的引用串（`<prefix>_<index>`）；无 backend 节点则没有。 */
  uid?: string
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
  /** 引用表：agent 后续动作只认这里的 `uid`。 */
  refs: AxRef[]
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

/** 把 CDP 节点数组剪成一棵树（忽略节点会被「抬升」，子节点接到父级）。 */
function buildTree(
  nodes: readonly AxNode[],
  options: Required<PruneOptions>,
): { tree: PrunedNode[]; nodeCount: number; truncated: boolean; refs: AxRef[] } {
  const byId = new Map<string, AxNode>()
  for (const node of nodes) byId.set(node.nodeId, node)

  let nodeCount = 0
  let truncated = false
  const refs: AxRef[] = []

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

    const pruned: PrunedNode = { role, children: [] }
    if (name) pruned.name = name
    if (value) pruned.value = value
    const properties = pickProperties(node, options.keepProperties)
    if (properties) pruned.properties = properties

    // 只有能反向定位到 DOM 的节点才给 uid —— 给了 uid 却点不动，比不给更糟。
    // ⚠ 必须在**展开孩子之前**分配：否则编号变成后序，与文本的渲染顺序对不上。
    if (typeof node.backendDOMNodeId === 'number') {
      const uid = `${options.uidPrefix}_${refs.length}`
      refs.push({ uid, backendDOMNodeId: node.backendDOMNodeId, role, ...(name ? { name } : {}) })
      pruned.uid = uid
    }

    const children: PrunedNode[] = []
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (!child) continue
      children.push(...build(child, depth + 1))
    }
    pruned.children = children
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
  return { tree, nodeCount, truncated, refs }
}

function render(nodes: readonly PrunedNode[], indent: string, lines: string[]): void {
  for (const node of nodes) {
    // Chrome MCP 的行格式：`uid=1_2 button "Reveal" disabled="true"`。
    // uid 必须**在缩进之后**，否则行首缩进就废了，层级也看不出来。
    const head = `${indent}${node.uid ? `uid=${node.uid} ` : ''}${node.role}`
    const parts = [head]
    if (node.name) parts.push(JSON.stringify(node.name))
    if (node.value) parts.push(`value=${JSON.stringify(node.value)}`)
    if (node.properties) {
      for (const [key, value] of Object.entries(node.properties)) {
        parts.push(`${key}=${JSON.stringify(value)}`)
      }
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

/** 主入口：CDP 节点数组 → 剪枝树 + 渲染文本 + 引用表。 */
export function pruneAxTree(nodes: readonly AxNode[], options: PruneOptions = {}): PruneResult {
  const resolved: Required<PruneOptions> = {
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    keepProperties: options.keepProperties ?? DEFAULT_KEEP_PROPERTIES,
    uidPrefix: options.uidPrefix ?? 1,
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
    // 文本被截断时，被截掉那部分节点的 uid 也不该再被当成可用手柄。
    refs: clipped.truncated
      ? built.refs.filter((ref) => clipped.text.includes(`uid=${ref.uid} `))
      : built.refs,
  }
}
