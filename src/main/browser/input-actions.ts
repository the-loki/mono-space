/**
 * 输入自动化（对齐 Chrome MCP 的 input automation 分类）。
 *
 * 全部经 CDP 的 `Input.*` / `DOM.*` 完成，产生**真实输入事件**（和真人操作等价），
 * 因此受控组件（React 等）会正常响应。
 *
 * 与 Chrome MCP 的唯一差别是**作用域**：只作用于 MonoSpace 内置会话的窗口。
 * 能力与行为保持原样——不额外加白名单、不限流、不拦按键。
 */
import type { BrowserWindow } from 'electron'
import { callOnElement, cdpSend, ensureDomain } from './cdp'

/** CDP 修饰键位掩码。 */
const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

/** 特殊键表（可打印字符按 `parseKeyCombo` 推导）。 */
const SPECIAL_KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Insert: { code: 'Insert', vk: 45 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
}

export interface ParsedKey {
  key: string
  code: string
  /** CDP 修饰键位掩码。 */
  modifiers: number
  /** 该键产生的文本（可打印字符），无则 undefined。 */
  text?: string
  /** Windows 虚拟键码。 */
  vk: number
}

/**
 * 解析 `press_key` 的组合键串，例如 `Enter`、`Control+A`、`Control+Shift+R`、`Control++`。
 *
 * 语义对齐 Chrome MCP / Puppeteer 的 `keyboard.press('Control+Shift+R')`：
 * 最后一段是主键，前面的是修饰键。
 */
export function parseKeyCombo(combo: string): ParsedKey {
  const parts = combo.split('+')
  // `Control++`：末段是空串，代表主键就是 `+`。
  const main = parts.length > 1 && parts[parts.length - 1] === '' ? '+' : (parts.pop() ?? '')
  const modifiers = parts.reduce((bits, name) => bits | (MODIFIER_BITS[name] ?? 0), 0)
  if (main === '') throw new Error(`按键组合无法解析：${combo}`)

  const special = SPECIAL_KEYS[main] ?? SPECIAL_KEYS[main.length === 1 ? main.toLowerCase() : main]
  if (special) {
    return {
      key: main === ' ' ? ' ' : main,
      code: special.code,
      modifiers,
      text: special.text,
      vk: special.vk,
    }
  }

  if (/^F([1-9]|1[0-2])$/.test(main)) {
    const index = Number(main.slice(1))
    return { key: main, code: main, modifiers, vk: 111 + index }
  }

  if (/^[a-zA-Z]$/.test(main)) {
    const upper = main.toUpperCase()
    return {
      key: modifiers & 8 ? upper : main.toLowerCase(),
      code: `Key${upper}`,
      modifiers,
      text: modifiers & (2 | 1 | 4) ? undefined : main.toLowerCase(),
      vk: upper.charCodeAt(0),
    }
  }

  if (/^[0-9]$/.test(main)) {
    return {
      key: main,
      code: `Digit${main}`,
      modifiers,
      ...(modifiers & (2 | 1 | 4) ? {} : { text: main }),
      vk: 48 + Number(main),
    }
  }

  const punctuation: Record<string, { code: string; vk: number }> = {
    '-': { code: 'Minus', vk: 189 },
    '=': { code: 'Equal', vk: 187 },
    '[': { code: 'BracketLeft', vk: 219 },
    ']': { code: 'BracketRight', vk: 221 },
    '\\': { code: 'Backslash', vk: 220 },
    ';': { code: 'Semicolon', vk: 186 },
    "'": { code: 'Quote', vk: 222 },
    ',': { code: 'Comma', vk: 188 },
    '.': { code: 'Period', vk: 190 },
    '/': { code: 'Slash', vk: 191 },
    '`': { code: 'Backquote', vk: 192 },
  }
  const punct = punctuation[main]
  if (punct) {
    return {
      key: main,
      code: punct.code,
      modifiers,
      ...(modifiers & (2 | 1 | 4) ? {} : { text: main }),
      vk: punct.vk,
    }
  }

  // 其余键（Unicode、少见符号）：只发 key/keyUp，不猜 code。
  return { key: main, code: '', modifiers, text: modifiers ? undefined : main, vk: 0 }
}

/** 元素几何：矩形 + 中心点（点击/悬停/拖拽的落点）。 */
export interface ElementBox {
  x: number
  y: number
  width: number
  height: number
  centerX: number
  centerY: number
}

/** 取元素矩形（先滚入视口，再取框模型）。 */
export async function elementBox(
  window: BrowserWindow,
  backendDOMNodeId: number,
): Promise<ElementBox> {
  await ensureDomain(window, 'DOM')
  await cdpSend(window, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backendDOMNodeId }).catch(
    () => {
      // 已经可见时部分实现会报错，不影响取框。
    },
  )
  const model = await cdpSend<{ model?: { border?: number[]; content?: number[] } }>(
    window,
    'DOM.getBoxModel',
    { backendNodeId: backendDOMNodeId },
  ).catch(() => null)
  const quad = model?.model?.content ?? model?.model?.border
  if (!quad || quad.length < 8) {
    throw new Error(
      `元素没有可见框（可能已消失、被隐藏，或页面已经变了）：backendNodeId=${backendDOMNodeId}`,
    )
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[]
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[]
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  }
}

async function mouse(
  window: BrowserWindow,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  x: number,
  y: number,
  options: { button?: 'left' | 'right' | 'middle'; clickCount?: number; buttons?: number } = {},
): Promise<void> {
  await cdpSend(window, 'Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: options.button ?? 'left',
    clickCount: options.clickCount ?? 1,
    buttons: options.buttons ?? (type === 'mousePressed' ? 1 : 0),
  })
}

/** 点击元素（`dblClick` 时连点两次）。 */
export async function clickElement(
  window: BrowserWindow,
  backendDOMNodeId: number,
  options: { dblClick?: boolean } = {},
): Promise<ElementBox> {
  const box = await elementBox(window, backendDOMNodeId)
  const count = options.dblClick ? 2 : 1
  await mouse(window, 'mouseMoved', box.centerX, box.centerY, { buttons: 0 })
  for (let index = 1; index <= count; index += 1) {
    await mouse(window, 'mousePressed', box.centerX, box.centerY, { clickCount: index })
    await mouse(window, 'mouseReleased', box.centerX, box.centerY, { clickCount: index })
  }
  return box
}

/** 在坐标点击（`--experimentalVision` 对应的 `click_at`）。 */
export async function clickAt(
  window: BrowserWindow,
  x: number,
  y: number,
  options: { dblClick?: boolean } = {},
): Promise<void> {
  const count = options.dblClick ? 2 : 1
  await mouse(window, 'mouseMoved', x, y, { buttons: 0 })
  for (let index = 1; index <= count; index += 1) {
    await mouse(window, 'mousePressed', x, y, { clickCount: index })
    await mouse(window, 'mouseReleased', x, y, { clickCount: index })
  }
}

/** 悬停到元素上。 */
export async function hoverElement(window: BrowserWindow, backendDOMNodeId: number): Promise<void> {
  const box = await elementBox(window, backendDOMNodeId)
  await mouse(window, 'mouseMoved', box.centerX, box.centerY, { buttons: 0 })
}

/** 把一个元素拖到另一个元素上（带中间插值，和真人拖动一致）。 */
export async function dragElement(
  window: BrowserWindow,
  fromBackendNodeId: number,
  toBackendNodeId: number,
): Promise<void> {
  const from = await elementBox(window, fromBackendNodeId)
  const to = await elementBox(window, toBackendNodeId)
  await mouse(window, 'mouseMoved', from.centerX, from.centerY, { buttons: 0 })
  await mouse(window, 'mousePressed', from.centerX, from.centerY)
  const steps = 10
  for (let index = 1; index <= steps; index += 1) {
    await mouse(
      window,
      'mouseMoved',
      from.centerX + ((to.centerX - from.centerX) * index) / steps,
      from.centerY + ((to.centerY - from.centerY) * index) / steps,
    )
  }
  await mouse(window, 'mouseReleased', to.centerX, to.centerY)
}

interface ElementInfo {
  tag: string
  type: string
  isContentEditable: boolean
  checked: boolean
  /** 当前值（input/textarea/select）。 */
  value: unknown
}

/** 读元素的 DOM 语义（决定 `fill` 该用哪种填法）。 */
export async function describeElement(
  window: BrowserWindow,
  backendDOMNodeId: number,
): Promise<ElementInfo> {
  await ensureDomain(window, 'DOM')
  return callOnElement<ElementInfo>(
    window,
    backendDOMNodeId,
    `function () {
      const el = this;
      return {
        tag: (el.tagName || '').toLowerCase(),
        type: (el.getAttribute && el.getAttribute('type')) || '',
        isContentEditable: Boolean(el.isContentEditable),
        checked: Boolean(el.checked),
        value: 'value' in el ? el.value : undefined,
      };
    }`,
  )
}

/** 按元素类型填值（对齐 Chrome MCP `fill`：input / textarea / select / checkbox / radio）。 */
export async function fillElement(
  window: BrowserWindow,
  backendDOMNodeId: number,
  value: string,
): Promise<{ tag: string; type: string }> {
  const info = await describeElement(window, backendDOMNodeId)
  const tag = info.tag
  const type = info.type.toLowerCase()

  if (type === 'checkbox' || type === 'radio') {
    const want = value.toLowerCase() === 'true'
    const isRadio = type === 'radio'
    // radio 传 "true" 即选中；checkbox 按目标状态决定是否点。
    if ((isRadio && want && !info.checked) || (!isRadio && want !== info.checked)) {
      await clickElement(window, backendDOMNodeId)
    }
    return { tag, type }
  }

  if (tag === 'select') {
    await callOnElement(
      window,
      backendDOMNodeId,
      `function (next) {
        const el = this;
        const option = Array.from(el.options || []).find(
          (candidate) => candidate.value === next || candidate.label === next || candidate.text === next,
        );
        el.value = option ? option.value : next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value;
      }`,
      [value],
    )
    return { tag, type }
  }

  // input / textarea / contenteditable：走真实输入事件（聚焦 → 全选 → 输入）。
  const box = await elementBox(window, backendDOMNodeId)
  await mouse(window, 'mousePressed', box.centerX, box.centerY)
  await mouse(window, 'mouseReleased', box.centerX, box.centerY)
  await cdpSend(window, 'DOM.focus', { backendNodeId: backendDOMNodeId }).catch(() => {
    // 不可聚焦的控件交给 insertText 落在当前焦点元素上。
  })
  await pressKeyCombo(window, 'Control+A')
  await cdpSend(window, 'Input.insertText', { text: value })

  // 少数控件（date/number/color 等）不吃 insertText：读回校验后兜底写值 + 派发事件。
  const after = await describeElement(window, backendDOMNodeId).catch(() => null)
  if (after && typeof after.value === 'string' && after.value !== value) {
    await callOnElement(
      window,
      backendDOMNodeId,
      `function (next) {
        const el = this;
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, next); else el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value;
      }`,
      [value],
    )
  }
  return { tag, type }
}

/** 逐字输入（对齐 `type_text`；先聚焦再输入）。 */
export async function typeText(
  window: BrowserWindow,
  text: string,
  options: { submitKey?: string } = {},
): Promise<void> {
  await cdpSend(window, 'Input.insertText', { text })
  if (options.submitKey) await pressKeyCombo(window, options.submitKey)
}

/** 按键 / 组合键（对齐 `press_key`）。 */
export async function pressKeyCombo(window: BrowserWindow, combo: string): Promise<void> {
  const parsed = parseKeyCombo(combo)
  const base = {
    modifiers: parsed.modifiers,
    key: parsed.key,
    code: parsed.code,
    windowsVirtualKeyCode: parsed.vk,
    nativeVirtualKeyCode: parsed.vk,
  }
  // 修饰键先按下，主键后按下，再逆序抬起（和真人一样）。
  const modifierNames = combo.split('+').filter((part) => part in MODIFIER_BITS)
  for (const name of modifierNames) {
    await cdpSend(window, 'Input.dispatchKeyEvent', {
      ...base,
      type: 'rawKeyDown',
      key: name,
      code: name === 'Meta' ? 'MetaLeft' : `${name}Left`,
      windowsVirtualKeyCode: 0,
      nativeVirtualKeyCode: 0,
      text: undefined,
    })
  }
  await cdpSend(window, 'Input.dispatchKeyEvent', {
    ...base,
    type: parsed.text && !parsed.modifiers ? 'keyDown' : 'rawKeyDown',
    ...(parsed.text && !parsed.modifiers ? { text: parsed.text } : {}),
  })
  await cdpSend(window, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  for (const name of [...modifierNames].reverse()) {
    await cdpSend(window, 'Input.dispatchKeyEvent', {
      ...base,
      type: 'keyUp',
      key: name,
      code: name === 'Meta' ? 'MetaLeft' : `${name}Left`,
      windowsVirtualKeyCode: 0,
      nativeVirtualKeyCode: 0,
      text: undefined,
    })
  }
}

/** 上传文件（对齐 `upload_file`）：目标可以是 file input，也可以是会唤起文件选择器的元素。 */
export async function uploadFile(
  window: BrowserWindow,
  backendDOMNodeId: number,
  filePaths: string[],
): Promise<{ files: string[] }> {
  const info = await describeElement(window, backendDOMNodeId)
  if (info.tag === 'input' && info.type.toLowerCase() === 'file') {
    await cdpSend(window, 'DOM.setFileInputFiles', {
      files: filePaths,
      backendNodeId: backendDOMNodeId,
    })
    return { files: filePaths }
  }

  // 不是 file input：拦截文件选择器，点一下，再用弹出来的那个 input 塞文件。
  await ensureDomain(window, 'Page')
  const opened = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('点击后没有出现文件选择器')), 5_000)
    const onMessage = (
      _event: unknown,
      method: string,
      params?: { backendNodeId?: number },
    ): void => {
      if (method !== 'Page.fileChooserOpened') return
      clearTimeout(timer)
      window.webContents.debugger.removeListener('message', onMessage as never)
      if (typeof params?.backendNodeId === 'number') resolve(params.backendNodeId)
      else reject(new Error('文件选择器没有给出元素句柄'))
    }
    window.webContents.debugger.on('message', onMessage as never)
  })
  await cdpSend(window, 'Page.setInterceptFileChooserDialog', { enabled: true })
  try {
    await clickElement(window, backendDOMNodeId)
    const chooserNode = await opened
    await cdpSend(window, 'DOM.setFileInputFiles', { files: filePaths, backendNodeId: chooserNode })
  } finally {
    await cdpSend(window, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {
      // 页面已跳走时关不掉，忽略。
    })
  }
  return { files: filePaths }
}

/** 处理浏览器对话框（`alert` / `confirm` / `prompt` / `beforeunload`）。 */
export async function handleDialog(
  window: BrowserWindow,
  action: 'accept' | 'dismiss',
  promptText?: string,
): Promise<void> {
  await ensureDomain(window, 'Page')
  await cdpSend(window, 'Page.handleJavaScriptDialog', {
    accept: action === 'accept',
    ...(promptText === undefined ? {} : { promptText }),
  })
}

/** 滚动（真实滚轮事件，不是脚本滚动）。 */
export async function scrollPage(
  window: BrowserWindow,
  direction: 'up' | 'down',
  amount = 800,
): Promise<void> {
  const { width, height } = window.getContentBounds()
  await cdpSend(window, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(width / 2),
    y: Math.round(height / 2),
    deltaX: 0,
    deltaY: direction === 'down' ? amount : -amount,
  })
}
