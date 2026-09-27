/**
 * 少量内联 SVG 图标（装饰性）。
 *
 * 为什么不装图标库：任务约束不允许加依赖，而这里只需要几个图标——一个库的体积和
 * 维护成本远超手写几条 path。全部 `aria-hidden`，因为它们旁边始终有中文文字标签
 * （窗口控制按钮则由按钮自己的 aria-label 承载含义），不需要再给屏幕阅读器加噪音。
 */
import type { JSX } from 'react'

interface IconProps {
  /** 边长（px），默认 16。 */
  size?: number
  className?: string
}

/** 品牌标记：层叠的卡片（「订单 + key」的台账意象，避免用 emoji 当图标）。 */
export function IconLedger({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
      <path d="M3 12.5 12 17l9-4.5" />
      <path d="M3 17 12 21.5 21 17" />
    </svg>
  )
}

/** 空态：收件盘。 */
export function IconInbox({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3 13h4l2 3h6l2-3h4" />
      <path d="M5.4 5h13.2l2.4 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4l2.4-8Z" />
    </svg>
  )
}

/** 空态：钥匙。 */
export function IconKey({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="8" cy="8" r="4.5" />
      <path d="m11.2 11.2 8 8" />
      <path d="m17 17 2-2" />
      <path d="m14 14 2-2" />
    </svg>
  )
}

/** 错误态：警告三角。 */
export function IconAlert({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M10.3 4.3 2.6 17.6A1.9 1.9 0 0 0 4.3 20.5h15.4a1.9 1.9 0 0 0 1.7-2.9L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

/** 折叠三角（日志面板用），由调用方用 CSS 旋转。 */
export function IconChevron({ size = 12, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** 返回箭头（明细视图）。 */
export function IconArrowLeft({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M15 5 8 12l7 7" />
    </svg>
  )
}

// —————————————— 自建标题栏的窗口控制（无边框窗口，见 ui/TitleBar.tsx） ——————————————
// 这三个图标全部描边、无填色（`currentColor`），所以浅色/悬停态都不用另调颜色。

/** 最小化：一条横线。 */
export function IconMinimize({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M5 12h14" />
    </svg>
  )
}

/** 最大化：单层方框。 */
export function IconMaximize({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  )
}

/** 还原：两层错位方框（与最大化图标成对，表示「再点会缩回去」）。 */
export function IconRestore({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="4.5" y="8.5" width="11" height="11" rx="1.5" />
      <path d="M8.5 8.5V6A1.5 1.5 0 0 1 10 4.5h8A1.5 1.5 0 0 1 19.5 6v8a1.5 1.5 0 0 1-1.5 1.5h-2.5" />
    </svg>
  )
}

/** 关闭：叉。 */
export function IconClose({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </svg>
  )
}

/** 检索：订单主视图的搜索框。 */
export function IconSearch({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

/** 从页面读取本单 key（落进台账）：向下的箭头 + 承接的托盘。 */
export function IconIngest({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 3v10" />
      <path d="m8 9 4 4 4-4" />
      <path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13A1.5 1.5 0 0 0 20 19.5V17" />
    </svg>
  )
}

/** 调试日志：终端窗口。 */
export function IconTerminal({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 2.5 2.5L7 14" />
      <path d="M12.5 14.5H17" />
    </svg>
  )
}
