/**
 * MonoSpace Humble 扩展（内容脚本）。
 *
 * 为什么在页面里 fetch 而不是主进程发请求（`docs/research/humble-reveal.md` §4.1）：
 * Cloudflare 对状态变更 POST 按 **HTTP/2 + TLS 指纹**识别，非真实浏览器上下文一律 403；
 * 同源 `fetch` 借真实 Chrome 指纹与 cookie，才能过。**GET 不受影响，POST 必受影响。**
 *
 * 本脚本只做「页面交互 + 取回执」，不做归类决策（归类在主进程 `outcome.ts` / `state.ts`）。
 */

const REDEEM_URL = '/humbler/redeemkey'

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_cookie=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

async function fetchJson(url, init) {
  const response = await fetch(url, { credentials: 'include', ...init })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

/** 递归找 order 详情里与 keytype 对应的条目，读 redeemed_key_val。 */
function findEntry(node, keytype, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return null
  seen.add(node)

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findEntry(child, keytype, seen)
      if (found) return found
    }
    return null
  }

  const machineName = node.machine_name || node.machineName
  if (machineName && String(machineName) === keytype) return node

  for (const value of Object.values(node)) {
    const found = findEntry(value, keytype, seen)
    if (found) return found
  }
  return null
}

async function isLoggedIn() {
  // 只读判定：能拿到订单接口（200）即视为登录态有效。
  const { status } = await fetchJson('/api/v1/user/order')
  return status === 200
}

async function handlePrecheck() {
  const loggedIn = await isLoggedIn()
  return { loggedIn, onPage: location.hostname === 'www.humblebundle.com' }
}

/** 只读试探：写之前确认「确实还没揭示」，也是恢复时的幂等判据。 */
async function handleProbe(payload) {
  const { gamekey, keytype } = payload || {}
  const { status, json } = await fetchJson(`/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`)
  if (status !== 200 || !json) {
    return { kind: 'unavailable', detail: `订单读取失败（HTTP ${status}）`, pause: 'unknown-page' }
  }
  const entry = findEntry(json, keytype)
  if (!entry) {
    return { kind: 'unavailable', detail: '订单里找不到该资产包（keyless / 已下架？）', pause: 'unavailable' }
  }
  const revealed = entry.redeemed_key_val || entry.key_val
  if (typeof revealed === 'string' && revealed.trim()) {
    return { kind: 'already-revealed', code: revealed.trim() }
  }
  if (entry.keyindex === undefined || entry.keyindex === null) {
    return { kind: 'unavailable', detail: '该条目没有 keyindex（keyless，揭示会直接发放）', pause: 'unavailable' }
  }
  return { kind: 'needs-reveal' }
}

/** 不可逆写操作：POST /humbler/redeemkey（同源，过 Cloudflare）。 */
async function handleReveal(payload) {
  const { gamekey, keytype, keyindex } = payload || {}
  const body = new URLSearchParams({
    keytype: String(keytype),
    key: String(gamekey),
    keyindex: String(keyindex)
  })
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest'
  }
  const token = csrfToken()
  if (token) headers['csrf-prevention-token'] = token

  const { status, json, text } = await fetchJson(REDEEM_URL, {
    method: 'POST',
    headers,
    body: body.toString()
  })

  if (status === 403) {
    return { success: false, error_msg: 'Cloudflare 403（需退避重试）', redeem_retryable: true }
  }
  if (!json) {
    return { success: false, error_msg: `非 JSON 响应（HTTP ${status}）：${text.slice(0, 200)}`, redeem_retryable: false }
  }
  return json
}

/** 2xx 但没带 key 时的只读补偿。 */
async function handleReread(payload) {
  const { gamekey, keytype } = payload || {}
  const { json } = await fetchJson(`/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`)
  if (!json) return { code: null }
  const entry = findEntry(json, keytype)
  const revealed = entry && (entry.redeemed_key_val || entry.key_val)
  return { code: typeof revealed === 'string' && revealed.trim() ? revealed.trim() : null }
}

const HANDLERS = {
  'reveal-precheck': handlePrecheck,
  'reveal-probe': handleProbe,
  'reveal-post': handleReveal,
  'reveal-reread': handleReread
}

function reply(response) {
  window.postMessage({ __monoSpaceExtension: true, payload: response }, '*')
}

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.__monoSpaceCommand !== true) return
  const { id, cmd, payload } = data.command || {}
  if (!id || !cmd) return

  const handler = HANDLERS[cmd]
  if (!handler) {
    reply({ id, ok: false, error: `未知命令：${cmd}` })
    return
  }
  Promise.resolve(handler(payload))
    .then((result) => reply({ id, ok: true, data: result }))
    .catch((error) => reply({ id, ok: false, error: String((error && error.message) || error) }))
})
