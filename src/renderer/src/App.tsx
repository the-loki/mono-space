import { useEffect, useState } from 'react'
import { LedgerPage } from './ledger/LedgerPage'
import { IconLedger } from './ui/icons'
import { TitleBar } from './ui/TitleBar'

export default function App(): React.JSX.Element {
  const [pong, setPong] = useState('')

  useEffect(() => {
    window.api.ping('hello').then(setPong)
  }, [])

  return (
    <div className="flex h-screen flex-col bg-canvas text-ink">
      {/* 品牌条即自建标题栏（用户决策：无系统 title bar）：整条可拖动，右侧是窗口控制。
          页面级标题仍然留给「订单」——标题栏只承担识别作用。 */}
      <TitleBar>
        <span
          className="flex size-7 items-center justify-center rounded-md border border-line-strong
            bg-surface text-accent"
        >
          <IconLedger size={15} />
        </span>
        <span className="font-semibold text-[15px] text-ink tracking-tight">MonoSpace</span>
        <span className="text-ink-3 text-xs">游戏资产管家</span>
        {/**
         * 这里是 preload 往返（contextBridge）的观测锚点，e2e 断言它等于 'pong:hello'。
         * 但对用户没有意义，所以**不渲染到界面上**（hidden）—— 别把调试痕迹留在标题栏。
         */}
        <p className="hidden" data-testid="ping-result">
          {pong}
        </p>
      </TitleBar>

      <main className="flex min-h-0 flex-1 flex-col px-5 py-4">
        <LedgerPage />
      </main>
    </div>
  )
}
