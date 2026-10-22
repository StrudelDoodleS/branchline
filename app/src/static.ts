// Branchline fork modifications; see FORK.md.
/**
 * Static file server for the pre-built webview assets.
 * Serves index.html, index.js, and index.css from app/dist/webview/.
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const WEBVIEW_DIR = path.join(__dirname, 'webview')

const HTML_SHELL = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Branchline</title>
  <link rel="stylesheet" href="/index.css">
  <style>html, body { height: 100%; margin: 0; padding: 0; }</style>
</head>
<body class="font-sans antialiased" style="background: #0a0a1a;">
  <div id="root" style="height: 100%;"></div>
  <script src="/index.js"></script>
</body>
</html>`

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
}

interface Representation { content: Buffer; etag: string }
interface CachedAsset { signature: string; identity: Representation; gzip?: Representation }
const assets = new Map<string, CachedAsset>()
const representation = (content: Buffer): Representation => ({ content,
  etag: `"${createHash('sha256').update(content).digest('hex')}"` })
const html: CachedAsset = { signature: '', identity: representation(Buffer.from(HTML_SHELL)) }

function acceptsGzip(header = ''): boolean {
  const encodings = new Map(header.toLowerCase().split(',').map(value => {
    const [name, ...parameters] = value.trim().split(';')
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='))
    return [name.trim(), quality === undefined ? 1 : Number(quality.trim().slice(2))] as const
  }))
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0
}

function sendAsset(req: http.IncomingMessage, res: http.ServerResponse, asset: CachedAsset, mime: string): void {
  const zipped = acceptsGzip(req.headers['accept-encoding'])
  // Compress once per asset generation, keeping repeated loads off the CPU.
  const selected = zipped ? asset.gzip ??= representation(gzipSync(asset.identity.content)) : asset.identity
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': mime, 'Cache-Control': 'no-cache',
    'ETag': selected.etag, 'Vary': 'Accept-Encoding', ...(zipped ? { 'Content-Encoding': 'gzip' } : {}) }
  const condition = req.headers['if-none-match']
  if (condition?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === selected.etag)) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': selected.content.length })
  res.end(selected.content)
}

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, webviewDir = WEBVIEW_DIR) {
  const url = req.url || '/'

  if (url === '/' || url === '/index.html') {
    sendAsset(req, res, html, 'text/html')
    return
  }

  // Only serve known asset files from the webview directory
  const basename = path.basename(url)
  const ext = path.extname(basename)
  const mime = MIME_TYPES[ext]

  if (!mime) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const filePath = path.join(webviewDir, basename)

  // Prevent path traversal
  if (!filePath.startsWith(webviewDir)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const stat = fs.statSync(filePath, { bigint: true })
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    let asset = assets.get(filePath)
    if (asset?.signature !== signature) {
      asset = { signature, identity: representation(fs.readFileSync(filePath)) }
      assets.delete(filePath)
      assets.set(filePath, asset)
      // The UI has only a few assets; bound memory for other requested files.
      while (assets.size > 8) assets.delete(assets.keys().next().value!)
    }
    sendAsset(req, res, asset, mime)
  } catch {
    assets.delete(filePath)
    res.writeHead(404)
    res.end('Not found')
  }
}
