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
        <p className="ml-auto text-xs opacity-50" data-testid="ping-result">
          {pong}
        </p>
      </header>
      <LedgerPage />
    </div>
  )
}
