// Branchline fork modifications; see FORK.md.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

const compress = promisify(gzip)
const MIN_GZIP_BYTES = 1024

function acceptsGzip(header = ''): boolean {
  const encodings = new Map(header.toLowerCase().split(',').map(value => {
    const [name, ...parameters] = value.trim().split(';')
    const weight = parameters.find(parameter => parameter.trim().startsWith('q='))
    const quality = weight === undefined ? 1 : Number(weight.trim().slice(2))
    return [name.trim(), Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0] as const
  }))
  // An explicit gzip refusal takes precedence over a permissive wildcard.
  return (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0
}

/** Send an uncached JSON representation, compressing substantial responses. */
export async function sendJson(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): Promise<void> {
  let body = Buffer.from(JSON.stringify(value))
  let zipped = false
  if (body.length >= MIN_GZIP_BYTES && acceptsGzip(req.headers['accept-encoding'])) {
    const compressed = await compress(body)
    if (compressed.length < body.length) {
      body = compressed
      zipped = true
    }
  }
  const vary = String(res.getHeader('Vary') ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (!vary.some(value => value === '*' || value.toLowerCase() === 'accept-encoding')) vary.push('Accept-Encoding')
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
    'Vary': vary.join(', '),
    ...(zipped ? { 'Content-Encoding': 'gzip' } : {}),
  })
  res.end(body)
}
