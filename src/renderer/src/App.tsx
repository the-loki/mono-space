import { useEffect, useState } from 'react'
import { LedgerPage } from './ledger/LedgerPage'

export default function App(): React.JSX.Element {
  const [pong, setPong] = useState('')

  useEffect(() => {
    window.api.ping('hello').then(setPong)
  }, [])

  return (
    <div className="flex h-screen flex-col gap-4 bg-slate-950 p-6 text-slate-100">
      <header className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">MonoSpace</h1>
        <p className="text-sm opacity-70">游戏资产管家</p>
        {/**
         * 这里是 preload 往返（contextBridge）的观测锚点，e2e 断言它等于 'pong:hello'。
         * 但对用户没有意义，所以**不渲染到界面上**（hidden）—— 别把调试痕迹留在标题栏。
         */}
        <p className="hidden" data-testid="ping-result">
          {pong}
        </p>
      </header>
      <LedgerPage />
    </div>
  )
}
