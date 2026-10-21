// Branchline fork modifications; see FORK.md.
'use client'

import { useEffect, useState } from 'react'
import type { SessionInfo } from '@/lib/bridge-types'

export function useSessionCatalog(enabled: boolean) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let active = true
    const timer = setTimeout(() => controller.abort(), 30000)
    setLoading(true); setError(undefined)
    const port = process.env.NEXT_PUBLIC_RELAY_PORT || ''
    const origin = port ? `http://127.0.0.1:${port}` : ''
    void fetch(`${origin}/session-catalog${version ? '?refresh=1' : ''}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Could not load saved sessions.')
        const data = await response.json() as { sessions: SessionInfo[] }
        if (!Array.isArray(data.sessions)) throw new Error('Saved sessions are unavailable.')
        if (active) setSessions(data.sessions)
      }).catch(() => { if (active) setError('Could not load saved sessions. Your recent sessions are still available.') })
      .finally(() => { clearTimeout(timer); if (active) setLoading(false) })
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [enabled, version])
  return { sessions, loading, error, refresh: () => setVersion(value => value + 1) }
}
