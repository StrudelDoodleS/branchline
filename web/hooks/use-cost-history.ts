// Branchline fork modifications; see FORK.md.
'use client'

import { useEffect, useState } from 'react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import type { CostHistory } from '../../extension/src/token-usage'

let nextRequest = 0

async function requestHistory(sessionId: string, signal: AbortSignal): Promise<CostHistory> {
  if (vscodeBridge?.isVSCode) {
    return new Promise((resolve, reject) => {
      const requestId = ++nextRequest
      const cleanup = () => { window.removeEventListener('message', receive); signal.removeEventListener('abort', abort) }
      const abort = () => { cleanup(); reject(new Error('Could not load cost history.')) }
      const receive = (event: MessageEvent) => {
        const data = event.data
        if (data?.type !== 'cost-history' || data.sessionId !== sessionId || data.requestId !== requestId) return
        cleanup()
        if (data.history) resolve(data.history)
        else reject(new Error('Cost history is unavailable.'))
      }
      if (signal.aborted) { abort(); return }
      window.addEventListener('message', receive)
      signal.addEventListener('abort', abort, { once: true })
      vscodeBridge!.requestCostHistory(sessionId, requestId)
    })
  }
  const port = process.env.NEXT_PUBLIC_RELAY_PORT || ''
  const origin = port ? `http://127.0.0.1:${port}` : ''
  const response = await fetch(`${origin}/session-cost-history?sessionId=${encodeURIComponent(sessionId)}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Could not load cost history.')
  const data = await response.json() as { sessionId: string; history: CostHistory }
  if (data.sessionId !== sessionId || !Array.isArray(data.history?.points)) throw new Error('Cost history is unavailable.')
  return data.history
}

export function useCostHistory(sessionId: string | null) {
  const [state, setState] = useState<{ sessionId: string | null; history?: CostHistory; error?: string }>({ sessionId: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!sessionId) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    setState({ sessionId })
    const load = async () => {
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 10000)
      try {
        const history = await requestHistory(sessionId, controller.signal)
        if (active) setState({ sessionId, history })
      } catch (error) {
        if (active) setState(previous => ({ ...previous, sessionId, error: error instanceof Error ? error.message : 'Could not load cost history.' }))
      } finally {
        clearTimeout(timeout)
        if (active) timer = setTimeout(load, 5000)
      }
    }
    void load()
    return () => { active = false; clearTimeout(timer); controller?.abort() }
  }, [sessionId, attempt])
  return { history: state.sessionId === sessionId ? state.history : undefined,
    error: state.sessionId === sessionId ? state.error : undefined, retry: () => setAttempt(value => value + 1) }
}
