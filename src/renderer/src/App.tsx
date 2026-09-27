import { useEffect, useState } from 'react'
import { LedgerPage } from './ledger/LedgerPage'
import { IconLedger } from './ui/icons'

export default function App(): React.JSX.Element {
  const [pong, setPong] = useState('')

  useEffect(() => {
    window.api.ping('hello').then(setPong)
  }, [])

  return (
    <div className="flex h-screen flex-col bg-canvas text-ink">
      {/* 品牌条：只承担识别作用（不是标题），页面级标题留给「订单」。 */}
      <header className="flex shrink-0 items-center gap-2.5 border-line border-b px-5 py-3">
        <span
          className="flex size-7 items-center justify-center rounded-md border border-line-strong
            bg-surface-2 text-accent"
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
      </header>

      <main className="flex min-h-0 flex-1 flex-col px-5 py-4">
        <LedgerPage />
      </main>
    </div>
  )
}
