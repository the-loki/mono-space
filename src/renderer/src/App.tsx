import { useEffect, useState } from 'react'

export default function App(): React.JSX.Element {
  const [pong, setPong] = useState('')

  useEffect(() => {
    window.api.ping('hello').then(setPong)
  }, [])

  return (
    <main className="p-8">
      <h1 className="text-xl font-semibold">MonoSpace</h1>
      <p className="text-sm opacity-70">游戏资产管家</p>
      <p className="mt-4" data-testid="ping-result">
        {pong}
      </p>
    </main>
  )
}
