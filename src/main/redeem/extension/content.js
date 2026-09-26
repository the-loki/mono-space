/**
 * MonoSpace 兑换扩展（内容脚本）。
 *
 * 职责：只做「页面交互」——登录态/页面判定、填码、点 Redeem/Confirm、读结果区、读库页标题。
 * 不做任何决策：结果原样回执给主进程，由主进程的状态机与错误码表归类。
 *
 * ⚠️ 选择器是**校准点**：Epic 兑换页的真实 DOM 需在首次人工登录时实测确认
 * （见 docs/spec/12-fab-redemption-flow.md 的 HITL 残差）。每条选择器都给了多个候选，
 * 找不到就如实回执 `onPage:false` / `page:'unknown'`，**绝不猜成功**。
 */

/** 每条选择器给多个候选，按序试。 */
const SELECTORS = {
  // 登录态：出现头像/账号菜单即视为已登录（Epic 顶栏）。
  loggedIn: [
    '[data-testid="user-menu"]',
    '#user-menu',
    'button[aria-label*="account" i]',
    'a[href*="/account/"]'
  ],
  // 兑换码输入框（Epic 账号兑换页）。
  codeInput: [
    'input[name="redeemCode"]',
    'input[data-testid="redeem-code-input"]',
    'input[placeholder*="code" i]',
    'input[type="text"]'
  ],
  // 「Redeem」提交按钮。
  redeemButton: [
    'button[data-testid="redeem-button"]',
    'button[type="submit"]'
  ],
  // 二次确认（EULA/Confirm）按钮。
  confirmButton: [
    'button[data-testid="confirm-button"]',
    'button[data-testid="accept-button"]'
  ],
  // 结果区（成功或错误）。
  resultArea: [
    '[data-testid="redeem-result"]',
    '[role="alert"]',
    '[aria-live]',
    '.error-message'
  ],
  // 人机校验（reCAPTCHA / Turnstile）。
  captcha: [
    'iframe[src*="recaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    '.g-recaptcha'
  ]
}

/** 「确认」按钮的可见文案（多语言兜底）。 */
const CONFIRM_TEXT = /confirm|确认|accept|同意|redeem now/i

function firstMatch(candidates) {
  for (const selector of candidates) {
    const el = document.querySelector(selector)
    if (el) return el
  }
  return null
}

function isVisible(el) {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等一个条件成立（用于等结果区出现）。 */
async function waitFor(predicate, timeoutMs = 15000, stepMs = 300) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(stepMs)
  }
}

/** 从结果区读出错误码与文案。码优先——Epic 有时把码放在 data 属性上。 */
function readResult() {
  const area = firstMatch(SELECTORS.resultArea)
  if (!area) return {}
  const text = (area.textContent || '').trim()
  const attr =
    area.getAttribute('data-error-code') ||
    area.getAttribute('data-code') ||
    area.querySelector('[data-error-code]')?.getAttribute('data-error-code') ||
    null
  return { errorCode: attr, message: text || null }
}

function onRedemptionPage() {
  return /\/account\/code-redemption/.test(location.pathname)
}

async function isLoggedIn() {
  return isVisible(firstMatch(SELECTORS.loggedIn))
}

async function handlePrecheck() {
  return { loggedIn: await isLoggedIn(), onPage: onRedemptionPage() }
}

/** 一次性：填码 → Redeem → （若有）Confirm → 读结果。 */
async function handleRedeem(payload) {
  const code = String((payload && payload.code) || '').trim()
  if (!code) return { page: 'unknown', message: '空兑换码' }

  if (firstMatch(SELECTORS.captcha)) return { page: 'captcha' }
  if (!(await isLoggedIn())) return { page: 'login' }
  if (!onRedemptionPage()) return { page: 'unknown', message: '不在兑换页' }

  const input = firstMatch(SELECTORS.codeInput)
  if (!input) return { page: 'unknown', message: '找不到兑换码输入框（选择器待校准）' }

  // 受控输入：同时派发 input/change，框架才会感知。
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, code)
  else input.value = code
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))

  const button = firstMatch(SELECTORS.redeemButton)
  if (!button) return { page: 'unknown', message: '找不到 Redeem 按钮（选择器待校准）' }
  button.click()

  // 二次确认是可选的官方步骤。
  const confirm = await waitFor(() => {
    const el = firstMatch(SELECTORS.confirmButton)
    if (!el) return null
    const label = (el.textContent || '').trim()
    return isVisible(el) && (el.getAttribute('data-testid')?.includes('confirm') || CONFIRM_TEXT.test(label))
      ? el
      : null
  }, 6000)
  if (confirm) {
    confirm.click()
    await sleep(800)
  }

  // 等人机校验（人在环路）：不点、不绕，如实回执。
  const captcha = await waitFor(() => firstMatch(SELECTORS.captcha), 3000, 200)
  if (captcha) return { page: 'captcha' }

  // 等结果区出现明确结果。
  const settled = await waitFor(() => {
    const result = readResult()
    if (result.errorCode || result.message) return result
    if (/success|成功|added to your library/i.test(document.body.innerText)) {
      return { success: true, message: '页面显示成功' }
    }
    return null
  }, 20000)

  if (!settled) return { page: 'unknown', message: '结果区未出现（选择器待校准）' }
  if (settled.success) return { page: 'redeem', success: true, message: settled.message }

  const looksFailed = /error|invalid|already|expired|not available|错误|无效|已拥有|已过期/i.test(
    settled.message || ''
  )
  if (settled.errorCode || looksFailed) {
    return { page: 'redeem', errorCode: settled.errorCode, message: settled.message }
  }
  // 既不像成功也不像失败 → 交人工。
  return { page: 'unknown', message: settled.message || '结果不可判定' }
}

/** 读库页的 listing 标题，供主进程做 My Library 校验。 */
function handleLibraryTitles() {
  const nodes = document.querySelectorAll(
    '[data-testid="listing-card"] , a[href*="/listings/"] , .listing-card'
  )
  const titles = []
  for (const node of nodes) {
    const text = (node.textContent || '').trim()
    if (text) titles.push(text)
  }
  return { titles }
}

const HANDLERS = {
  precheck: handlePrecheck,
  redeem: handleRedeem,
  'library-titles': handleLibraryTitles
}

function reply(response) {
  window.postMessage({ __monoSpaceExtension: true, payload: response }, '*')
}

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.__monoSpaceCommand !== true) return
  const command = data.command || {}
  const { id, cmd, payload } = command
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
