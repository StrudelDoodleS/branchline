// Branchline fork modifications; see FORK.md.
'use client'

import { useCallback, useSyncExternalStore } from 'react'

const subscribe = (notify: () => void) => {
  document.addEventListener('visibilitychange', notify)
  return () => document.removeEventListener('visibilitychange', notify)
}
const visible = () => !document.hidden
const serverVisible = () => true

export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, visible, serverVisible)
}

export function useMediaQuery(query: string): boolean {
  const listen = useCallback((notify: () => void) => {
    const media = matchMedia(query)
    media.addEventListener('change', notify)
    return () => media.removeEventListener('change', notify)
  }, [query])
  const snapshot = useCallback(() => matchMedia(query).matches, [query])
  return useSyncExternalStore(listen, snapshot, () => false)
}
