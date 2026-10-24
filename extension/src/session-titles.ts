// Branchline fork modifications; see FORK.md.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isCodexReviewAction } from './codex-session-metadata'
import type { ClaudeSessionMetadataReader } from './claude-session-metadata'

export const sessionTitle = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, 180) : undefined

export interface ClaudeSessionTitle { label: string; source: 'custom' | 'auto' }

export function claudeSessionTitle(record: { type?: unknown; customTitle?: unknown; aiTitle?: unknown }): ClaudeSessionTitle | undefined {
  const source = record.type === 'custom-title' ? 'custom' : record.type === 'ai-title' ? 'auto' : undefined
  const label = source && sessionTitle(source === 'custom' ? record.customTitle : record.aiTitle)
  return source && label ? { label, source } : undefined
}

export function preferClaudeTitle(current: ClaudeSessionTitle | undefined, next: ClaudeSessionTitle | undefined): ClaudeSessionTitle | undefined {
  return next && (next.source === 'custom' || current?.source !== 'custom') ? next : current
}

/** Small metadata files only; transcript contents are read by their existing parsers.
 * Stat signatures avoid re-reading unchanged indexes on the watcher fallback. */
export class SessionTitleReader {
  private files = new Map<string, { signature: string; titles: Map<string, string> }>()
  constructor(private readonly native?: Pick<ClaudeSessionMetadataReader, 'getTitle'>) {}

  private read(file: string, parse: (text: string) => Map<string, string>): Map<string, string> {
    try {
      const stat = fs.statSync(file)
      const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
      const cached = this.files.get(file)
      if (cached?.signature === signature) return cached.titles
      const titles = parse(fs.readFileSync(file, 'utf8'))
      this.files.set(file, { signature, titles })
      return titles
    } catch {
      this.files.delete(file)
      return new Map()
    }
  }

  claude(transcript: string): string | undefined {
    const native = this.native?.getTitle(path.basename(transcript, '.jsonl'))
    if (native) return native
    const file = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'custom-title.json')
    return this.read(file, text => {
      const title = sessionTitle(JSON.parse(text)?.customTitle)
      return new Map(title ? [['title', title]] : [])
    }).get('title')
  }

  codex(home: string, id: string): string | undefined {
    return this.read(path.join(home, 'session_index.jsonl'), text => {
      const titles = new Map<string, string>()
      for (const line of text.split('\n')) {
        try {
          const entry = JSON.parse(line)
          const id = entry?.id ?? entry?.session_id ?? entry?.thread_id
          const title = sessionTitle(entry?.thread_name) ?? sessionTitle(entry?.title)
          if (typeof id === 'string' && title && !isCodexReviewAction(title)) titles.set(id, title)
        } catch { /* Ignore an incomplete append without hiding earlier valid names. */ }
      }
      return titles
    }).get(id)
  }
}
