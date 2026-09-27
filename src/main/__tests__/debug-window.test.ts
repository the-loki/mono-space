import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 假的 BrowserWindow：只实现调试窗口用到的面（构造参数、ready-to-show、加载、聚焦、销毁）。
 * 单实例逻辑靠 `isDestroyed()` 判断，所以这里必须能真被「销毁」。
 */
const fake = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    readonly options: Record<string, unknown>
    readonly loaded: string[] = []
    focused = 0
    shown = 0
    destroyed = false

    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeBrowserWindow.instances.push(this)
    }

    on(event: string, listener: () => void): void {
      if (event === 'ready-to-show') listener()
    }

    loadURL(url: string): Promise<void> {
      this.loaded.push(url)
      return Promise.resolve()
    }

    loadFile(file: string): Promise<void> {
      this.loaded.push(file)
      return Promise.resolve()
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    focus(): void {
      this.focused += 1
    }

    show(): void {
      this.shown += 1
    }
  }
  return { FakeBrowserWindow }
})

vi.mock('electron', () => ({ BrowserWindow: fake.FakeBrowserWindow }))

const { openDebugWindow } = await import('../debug-window')

type FakeWindow = InstanceType<typeof fake.FakeBrowserWindow>

/** 打开调试窗口并把它当成假窗口用（模块声明的返回类型是真实 BrowserWindow）。 */
function open(): FakeWindow {
  return openDebugWindow() as unknown as FakeWindow
}

function openedWindows(): FakeWindow[] {
  return fake.FakeBrowserWindow.instances
}

describe('openDebugWindow：调试面板的独立窗口', () => {
  beforeEach(() => {
    openedWindows().length = 0
    delete process.env.ELECTRON_RENDERER_URL
  })

  // 销毁掉上一个用例留下的窗口 = 把单例归零，各用例互不干扰。
  afterEach(() => {
    for (const window of openedWindows()) window.destroyed = true
  })

  it('首次调用建窗口：约 900x600、可缩放、标题为调试日志、复用同一个 preload', () => {
    const window = open()
    expect(openedWindows()).toHaveLength(1)
    expect(window.options.width).toBe(900)
    expect(window.options.height).toBe(600)
    expect(window.options.title).toBe('MonoSpace 调试日志')
    expect(window.options.resizable).not.toBe(false)
    // sandboxed preload 与应用主窗口同一个产物。
    const webPreferences = window.options.webPreferences as { preload: string; sandbox: boolean }
    expect(webPreferences.preload.endsWith('preload/index.cjs')).toBe(true)
    expect(webPreferences.sandbox).toBe(true)
  })

  it('已开则只聚焦，不重复建窗口（幂等）', () => {
    const first = open()
    const second = open()
    expect(openedWindows()).toHaveLength(1)
    expect(second).toBe(first)
    expect(first.focused).toBe(1)
  })

  it('生产态加载构建产物里的 renderer/debug.html', () => {
    const window = open()
    expect(window.loaded).toHaveLength(1)
    expect(window.loaded[0].endsWith('renderer/debug.html')).toBe(true)
  })

  it('开发态加载 ${ELECTRON_RENDERER_URL}/debug.html', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    const window = open()
    expect(window.loaded).toEqual(['http://localhost:5173/debug.html'])
  })

  it('窗口被关掉后再调用会重开一个（单例不粘死）', () => {
    const first = open()
    first.destroyed = true
    const second = open()
    expect(openedWindows()).toHaveLength(2)
    expect(second).not.toBe(first)
  })

  it('ready-to-show 时才显示（避免白屏）', () => {
    const window = open()
    expect(window.shown).toBe(1)
  })
})
