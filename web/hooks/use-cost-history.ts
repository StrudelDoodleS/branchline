// Branchline fork modifications; see FORK.md.
'use client'

import { useCallback, useEffect, useState } from 'react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import type { CostHistory, CostHistoryOptions } from '../../extension/src/token-usage'

let nextRequest = 0

async function requestHistory(sessionId: string, options: CostHistoryOptions, signal: AbortSignal): Promise<CostHistory> {
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
      vscodeBridge!.requestCostHistory(sessionId, requestId, options)
    })
  }
  const port = process.env.NEXT_PUBLIC_RELAY_PORT || ''
  const origin = port ? `http://127.0.0.1:${port}` : ''
  const query = new URLSearchParams({ sessionId })
  for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value))
  const response = await fetch(`${origin}/session-cost-history?${query}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Could not load cost history.')
  const data = await response.json() as { sessionId: string; history: CostHistory }
  if (data.sessionId !== sessionId || !Array.isArray(data.history?.points)) throw new Error('Cost history is unavailable.')
  return data.history
}

export function useCostHistory(sessionId: string | null, options: CostHistoryOptions = {}, refreshMs: number | null = 5000) {
  const queryKey = JSON.stringify(options)
  // A different range can preview the loaded series. A different session,
  // model filter or bucket resolution must never reuse that series.
  const scopeKey = JSON.stringify([options.groupBy ?? 'model', options.group ?? null, options.resolution ?? 'auto'])
  const [state, setState] = useState<{
    sessionId: string | null; scopeKey?: string; queryKey?: string; historyQueryKey?: string;
    history?: CostHistory; error?: string; loading?: boolean;
  }>({ sessionId: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!sessionId) return
    const query = JSON.parse(queryKey) as CostHistoryOptions
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    setState(previous => ({ sessionId, scopeKey, queryKey, loading: true,
      ...(previous.sessionId === sessionId && previous.scopeKey === scopeKey
        ? { history: previous.history, historyQueryKey: previous.historyQueryKey } : {}) }))
    const load = async () => {
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 10000)
      try {
        const history = await requestHistory(sessionId, query, controller.signal)
        if (active) setState({ sessionId, scopeKey, queryKey, historyQueryKey: queryKey, history, loading: false })
      } catch (error) {
        if (active) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Could not load cost history.', loading: false }))
      } finally {
        clearTimeout(timeout)
        if (active && refreshMs !== null) timer = setTimeout(load, refreshMs)
      }
    }
    void load()
    return () => { active = false; clearTimeout(timer); controller?.abort() }
  }, [sessionId, scopeKey, queryKey, attempt, refreshMs])
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  const compatible = state.sessionId === sessionId && state.scopeKey === scopeKey
  const current = compatible && state.queryKey === queryKey
  return { history: compatible ? state.history : undefined,
    isPreviousData: compatible && !!state.history && state.historyQueryKey !== queryKey,
    loading: !!sessionId && (!current || !!state.loading),
    error: current ? state.error : undefined, retry }
}
