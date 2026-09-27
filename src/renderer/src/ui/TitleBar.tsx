/**
 * 自建标题栏（`frame: false` 的无边框窗口，见 main/index.ts、main/debug-window.ts）。
 *
 * 为什么必须自建：去掉系统标题栏后窗口既不能拖动、也点不到关闭，所以整条设为拖动区域
 * （`.app-drag`，见 assets/main.css），把窗口控制收敛到右侧三个按钮。按钮必须是 `.app-no-drag`
 * —— 拖动区域会吞掉鼠标事件，漏了就点不动。主窗口与调试窗口共用本组件，保证无边框风格一致。
 *
 * 按钮状态同步：点完先乐观更新，同时订阅主进程广播的 `maximize` / `unmaximize`
 * —— 双击标题栏 / 快捷键 / WM 直接最大化也能反映到图标上（见 main/window-controls.ts）。
 */
import { type JSX, type ReactNode, useCallback, useEffect, useState } from 'react'
import { IconClose, IconMaximize, IconMinimize, IconRestore } from './icons'

interface TitleBarProps {
  /** 左侧内容（主窗口是品牌条，调试窗口是窗名）。 */
  children: ReactNode
  /** 是否显示最大化 / 还原按钮（工具窗只留关闭）。 */
  showMaximize?: boolean
}

/** 窗口控制按钮的公共样式：方正的图标按钮，悬停才亮起来。 */
const CONTROL =
  'app-no-drag flex h-7 w-9 items-center justify-center rounded text-ink-2 transition-colors'

/** 自建标题栏。 */
export function TitleBar({ children, showMaximize = true }: TitleBarProps): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  // 首帧拉一次真实状态（渲染层不知道窗口建出来时是不是最大化的）+ 之后订阅变化。
  useEffect(() => {
    let active = true
    void window.api.window.isMaximized().then((value) => {
      if (active) setMaximized(value)
    })
    const unsubscribe = window.api.window.onMaximizedChange(setMaximized)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const handleToggleMaximize = useCallback(async () => {
    setMaximized(await window.api.window.toggleMaximize())
  }, [])

  return (
    <header className="app-drag flex h-10 shrink-0 items-center gap-2.5 border-line border-b bg-surface-2 px-4">
      {children}
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          aria-label="最小化"
          onClick={() => void window.api.window.minimize()}
          className={`${CONTROL} hover:bg-surface-hover hover:text-ink`}
        >
          <IconMinimize size={14} />
        </button>
        {showMaximize && (
          <button
            type="button"
            aria-label={maximized ? '还原' : '最大化'}
            onClick={() => void handleToggleMaximize()}
            className={`${CONTROL} hover:bg-surface-hover hover:text-ink`}
          >
            {maximized ? <IconRestore size={14} /> : <IconMaximize size={14} />}
          </button>
        )}
        {/* 关闭是破坏性动作，悬停用红底白字（实测 4.83:1）区分于另外两个中立按钮。 */}
        <button
          type="button"
          aria-label="关闭"
          onClick={() => void window.api.window.close()}
          className={`${CONTROL} hover:bg-red-600 hover:text-white`}
        >
          <IconClose size={14} />
        </button>
      </div>
    </header>
  )
}
