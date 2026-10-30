import * as fs from 'fs'
import { StringDecoder } from 'node:string_decoder'

interface FileLineBatch { lines: string[]; newSize: number; tail: string }

/** Stream a fixed catch-up snapshot without creating one file-sized string.
 * A decoder preserves UTF-8 characters split across internal read boundaries. */
export function* readNewFileLineBatches(filePath: string, lastSize: number, lastTail = '', chunkBytes = 1024 * 1024): Generator<FileLineBatch> {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) throw new RangeError('chunkBytes must be positive')
  let size: number
  try { size = fs.statSync(filePath).size } catch { return }
  if (size < lastSize) { yield { lines: [], newSize: 0, tail: '' }; return }
  if (size === lastSize) return
  let fd: number
  try { fd = fs.openSync(filePath, 'r') } catch { return }
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.alloc(Math.min(chunkBytes, size - lastSize))
  let offset = lastSize
  let tail = lastTail
  try {
    while (offset < size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset)
      if (count === 0) break
      offset += count
      const parts = (tail + decoder.write(buffer.subarray(0, count))).split(/\r?\n/)
      tail = parts.pop() ?? ''
      if (offset === size) tail += decoder.end()
      yield { lines: parts.filter(Boolean), newSize: offset, tail }
    }
  } finally { fs.closeSync(fd) }
}

/**
 * Read a chunk of bytes from a file at a given offset.
 * Uses try/finally to guarantee the file descriptor is always closed.
 */
export function readFileChunk(filePath: string, offset: number, length: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, offset)
    return buffer.toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Read new lines appended to a file since `lastSize` bytes.
 * Returns the new lines, updated file size, and any trailing partial line
 * (bytes past the last newline) as `tail` — pass it back on the next call as
 * `lastTail` to reassemble lines split across reads. If callers ignore `tail`,
 * they silently lose any line that wasn't fully flushed by the writer yet.
 * Handles truncation (file shrunk) by resetting to 0.
 */
export function readNewFileLines(
  filePath: string,
  lastSize: number,
  lastTail = '',
): { lines: string[]; newSize: number; tail: string } | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch { return null /* expected if file was removed */ }

  if (stat.size < lastSize) {
    // File was truncated — reset both size and tail
    return { lines: [], newSize: 0, tail: '' }
  }
  if (stat.size <= lastSize) {
    return null
  }

  const newContent = lastTail + readFileChunk(filePath, lastSize, stat.size - lastSize)
  const parts = newContent.split(/\r?\n/)
  // Last fragment is whatever follows the final newline — empty if the file
  // ended on a newline, otherwise a partial line we need to carry forward.
  const tail = parts.pop() ?? ''
  const lines = parts.filter(Boolean)
  return { lines, newSize: stat.size, tail }
}

/** Case-fold a path string for comparison on Windows, where the filesystem is
 *  case-insensitive and tools disagree on drive-letter case (VS Code reports
 *  `c:\...`, Claude Code and most shells report `C:\...`). Identity elsewhere. */
export function foldPathCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}
