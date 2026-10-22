// Branchline fork modifications; see FORK.md.
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePageVisible } from '@/hooks/use-page-visible'
import type { SpendOverviewResponse, SpendOverviewStatus } from '../../extension/src/spend-overview'

export function useSpendOverview(enabled: boolean, query: { start?: number; timezone: string; provider: string; model?: string }) {
  const visible = usePageVisible()
  const parameters = new URLSearchParams(Object.entries(query).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]))
  const scope = new URLSearchParams(parameters); scope.delete('end')
  const scopeKey = scope.toString(), queryKey = parameters.toString()
  const [snapshot, setSnapshot] = useState<{ key: string; data: SpendOverviewResponse }>()
  const [progress, setProgress] = useState<{ key: string; status: SpendOverviewStatus }>()
  const [failure, setFailure] = useState<{ key: string; error: string }>()
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const forceNext = useRef(false)

  useEffect(() => {
    if (!enabled || !visible) return
    let active = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const force = forceNext.current; forceNext.current = false
    const port = process.env.NEXT_PUBLIC_RELAY_PORT || ''
    const origin = port ? `http://127.0.0.1:${port}` : ''
    setLoading(true); setFailure(undefined)
    const request = async (suffix: string) => {
      const response = await fetch(`${origin}/spend-overview?${suffix}`, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error('Could not load spend dashboard.')
      return response.json()
    }
    const failed = () => {
      if (!active) return
      setLoading(false)
      setFailure({ key: scopeKey, error: 'Could not update the spend dashboard. Any previous figures shown are from the last successful update.' })
    }
    const schedule = () => { if (active) timer = setTimeout(() => { void poll().catch(failed) }, 1500) }
    const load = async (refresh = false) => {
      const data = await request(`${queryKey}${refresh ? '&refresh=1' : ''}`) as SpendOverviewResponse
      if (!data.status || !data.totals || !Array.isArray(data.sessions) || !Array.isArray(data.days)) throw new Error('Invalid spend dashboard.')
      if (!active) return
      setSnapshot({ key: scopeKey, data }); setProgress({ key: scopeKey, status: data.status }); setLoading(false)
      if (data.status.state === 'indexing') schedule()
    }
    const poll = async () => {
      const data = await request('status=1') as { status: SpendOverviewStatus }
      if (!data.status) throw new Error('Invalid spend progress.')
      if (!active) return
      setProgress({ key: scopeKey, status: data.status })
      if (data.status.state === 'indexing') schedule()
      else await load()
    }
    void load(force).catch(failed)
    return () => { active = false; controller.abort(); clearTimeout(timer) }
  }, [enabled, queryKey, scopeKey, revision, visible])

  const data = snapshot?.key === scopeKey ? snapshot.data : undefined
  const refresh = useCallback(() => { forceNext.current = true; setRevision(value => value + 1) }, [])
  return {
    data,
    status: progress?.key === scopeKey ? progress.status : data?.status,
    error: failure?.key === scopeKey ? failure.error : undefined,
    loading,
    refresh,
  }
}
