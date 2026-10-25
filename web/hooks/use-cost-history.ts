// Branchline fork modifications; see FORK.md.
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePageVisible } from '@/hooks/use-page-visible'
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
  const visible = usePageVisible()
  const queryKey = JSON.stringify(options)
  // A different range can preview the loaded series. A different session,
  // model filter or bucket resolution must never reuse that series.
  const scopeKey = JSON.stringify([options.groupBy ?? 'model', options.group ?? null, options.resolution ?? 'auto'])
  const [state, setState] = useState<{
    sessionId: string | null; scopeKey?: string; queryKey?: string; historyQueryKey?: string;
    history?: CostHistory; historySignature?: string; error?: string; loading?: boolean;
  }>({ sessionId: null })
  const [attempt, setAttempt] = useState(0)
  const completed = useRef<{ sessionId: string; queryKey: string; attempt: number; history: CostHistory; historySignature: string } | null>(null)
  useEffect(() => {
    if (!sessionId || !visible) return
    // Completed comparison days have no refresh timer. Keep their successful
    // result when the page resumes; live queries always fetch fresh figures.
    const cached = completed.current
    if (refreshMs === null && cached?.sessionId === sessionId && cached.queryKey === queryKey && cached.attempt === attempt) {
      setState(previous => previous.sessionId === sessionId && previous.queryKey === queryKey
        && previous.history === cached.history && !previous.loading && !previous.error ? previous
        : { sessionId, scopeKey, queryKey, historyQueryKey: queryKey, history: cached.history, historySignature: cached.historySignature, loading: false })
      return
    }
    const query = JSON.parse(queryKey) as CostHistoryOptions
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    setState(previous => ({ sessionId, scopeKey, queryKey, loading: true,
      ...(previous.sessionId === sessionId && previous.scopeKey === scopeKey
        ? { history: previous.history, historySignature: previous.historySignature, historyQueryKey: previous.historyQueryKey } : {}) }))
    const load = async () => {
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), query.timeline ? 30000 : 10000)
      try {
        const history = await requestHistory(sessionId, query, controller.signal)
        if (active) {
          // Polling often returns exactly the same history. Preserve its identity
          // so unchanged data does not rebuild chart paths and day comparisons.
          // Include every field, including unpriced/cache-write warnings.
          const historySignature = JSON.stringify(history)
          completed.current = { sessionId, queryKey, attempt, history, historySignature }
          setState(previous => {
            const same = previous.sessionId === sessionId && previous.scopeKey === scopeKey
              && previous.historySignature === historySignature
            if (same && previous.queryKey === queryKey && !previous.loading && !previous.error) return previous
            return { sessionId, scopeKey, queryKey, historyQueryKey: queryKey, historySignature,
              history: same ? previous.history : history, loading: false }
          })
        }
      } catch (error) {
        if (active) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Could not load cost history.', loading: false }))
      } finally {
        clearTimeout(timeout)
        if (active && refreshMs !== null) timer = setTimeout(load, refreshMs)
      }
    }
    void load()
    return () => { active = false; clearTimeout(timer); controller?.abort() }
  }, [sessionId, scopeKey, queryKey, attempt, refreshMs, visible])
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  const compatible = state.sessionId === sessionId && state.scopeKey === scopeKey
  const current = compatible && state.queryKey === queryKey
  return { history: compatible ? state.history : undefined,
    isPreviousData: compatible && !!state.history && state.historyQueryKey !== queryKey,
    loading: !!sessionId && (!current || !!state.loading),
    error: current ? state.error : undefined, retry }
}
