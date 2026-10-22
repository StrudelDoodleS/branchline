// Branchline fork modifications; see FORK.md.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { gunzipSync } from 'node:zlib'
import { serveStatic } from './static'

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'branchline-static-'))
  const javascript = 'const title = "Branchline";\n'.repeat(100)
  const css = '.session { color: white; background: black; }\n'.repeat(100)
  await fs.writeFile(path.join(directory, 'index.js'), javascript)
  await fs.writeFile(path.join(directory, 'index.css'), css)
  const server = http.createServer((req, res) => serveStatic(req, res, directory))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await fs.rm(directory, { recursive: true, force: true })
  })
  const port = (server.address() as import('node:net').AddressInfo).port
  const get = (url: string, headers: http.OutgoingHttpHeaders = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    }).on('error', reject)
  })
  return { directory, javascript, css, get }
}

// Catches resending the full bundle over 5G, corrupting gzip, or compressing a client that rejects it.
test('serves compressed assets with exact bytes and respects gzip negotiation', async t => {
  const f = await fixture(t)
  for (const [file, content, mime] of [['index.js', f.javascript, 'application/javascript'], ['index.css', f.css, 'text/css']]) {
    const plain = await f.get(`/${file}`)
    assert.equal(plain.status, 200)
    assert.equal(plain.headers['content-type'], mime)
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.equal(plain.body.toString(), content)
    const zipped = await f.get(`/${file}`, { 'Accept-Encoding': 'br, gzip;q=0.8' })
    assert.equal(zipped.status, 200)
    assert.equal(zipped.headers['content-encoding'], 'gzip')
    assert.equal(zipped.headers.vary, 'Accept-Encoding')
    assert.equal(gunzipSync(zipped.body).toString(), content)
    assert.ok(zipped.body.length < plain.body.length / 2)
    assert.equal(Number(zipped.headers['content-length']), zipped.body.length)
    assert.notEqual(zipped.headers.etag, plain.headers.etag, 'Strong validators distinguish transfer representations')
    for (const encoding of ['gzip;q=0, *;q=1', 'gzip ;q=0, *;q=1']) {
      const rejected = await f.get(`/${file}`, { 'Accept-Encoding': encoding })
      assert.equal(rejected.headers['content-encoding'], undefined)
      assert.equal(rejected.body.toString(), content)
    }
  }
})

// Catches always retransmitting the UI on reload and validators becoming invalid across encodings.
test('revalidates HTML and assets without transferring their bodies', async t => {
  const f = await fixture(t)
  for (const url of ['/', '/index.html', '/index.js', '/index.css']) {
    const first = await f.get(url, { 'Accept-Encoding': 'gzip' })
    assert.equal(first.status, 200)
    assert.equal(first.headers['cache-control'], 'no-cache')
    assert.match(first.headers.etag ?? '', /^".+"$/)
    const unchanged = await f.get(url, { 'Accept-Encoding': 'gzip', 'If-None-Match': `"different", W/${first.headers.etag}` })
    assert.equal(unchanged.status, 304)
    assert.equal(unchanged.body.length, 0)
    assert.equal(unchanged.headers.etag, first.headers.etag)
    assert.equal(unchanged.headers.vary, 'Accept-Encoding')
  }
})

// Catches serving a previous build forever or reusing its ETag after a same-size atomic replacement.
test('invalidates compressed assets and validators when a build replaces or removes a file', async t => {
  const f = await fixture(t)
  const file = path.join(f.directory, 'index.js')
  const first = await f.get('/index.js', { 'Accept-Encoding': 'gzip' })
  assert.equal(first.status, 200)
  assert.ok(first.headers.etag)
  const stat = await fs.stat(file)
  const changed = f.javascript.replaceAll('Branchline', 'New title!')
  assert.equal(Buffer.byteLength(changed), stat.size)
  const replacement = `${file}.next`
  await fs.writeFile(replacement, changed)
  await fs.utimes(replacement, stat.atime, stat.mtime)
  await fs.rename(replacement, file)
  const updated = await f.get('/index.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag })
  assert.equal(updated.status, 200)
  assert.equal(gunzipSync(updated.body).toString(), changed)
  assert.notEqual(updated.headers.etag, first.headers.etag)
  await fs.unlink(file)
  assert.equal((await f.get('/index.js')).status, 404)
})

test('page declares browser and phone icons on bookmarked URLs with query parameters', async t => {
  const f = await fixture(t)
  for (const url of ['/', '/index.html', '/?from=bookmark']) {
    const response = await f.get(url)
    assert.equal(response.status, 200)
    const html = response.body.toString()
    assert.match(html, /rel="icon"[^>]*href="\/icon\.svg\?v=1"/)
    assert.match(html, /rel="icon"[^>]*sizes="32x32"[^>]*href="\/icon-32\.png\?v=1"/)
    assert.match(html, /rel="apple-touch-icon"[^>]*sizes="180x180"[^>]*href="\/apple-touch-icon\.png\?v=1"/)
    assert.match(html, /rel="manifest"[^>]*href="\/site\.webmanifest\?v=1"/)
  }
})

test('serves icon formats and manifest with correct media types and query-safe cache validation', async t => {
  const f = await fixture(t)
  const files = [
    ['icon.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M20 15v34h24"/></svg>'), 'image/svg+xml'],
    ['icon-32.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'), 'image/png'],
    ['favicon.ico', Buffer.from([0, 0, 1, 0, 0, 0, 128, 255]), 'image/x-icon'],
    ['site.webmanifest', Buffer.from('{"name":"Branchline","icons":[]}'), 'application/manifest+json'],
  ] as const
  for (const [name, content, mime] of files) {
    await fs.writeFile(path.join(f.directory, name), content)
    const response = await f.get(`/${name}?v=1`, { 'Accept-Encoding': 'gzip' })
    assert.equal(response.status, 200, name)
    assert.equal(response.headers['content-type'], mime)
    const body = response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body
    assert.deepEqual(body, content)
    if (mime === 'image/png' || mime === 'image/x-icon') assert.equal(response.headers['content-encoding'], undefined)
    const unchanged = await f.get(`/${name}?v=1`, { 'Accept-Encoding': 'gzip', 'If-None-Match': response.headers.etag })
    assert.equal(unchanged.status, 304)
    assert.equal(unchanged.body.length, 0)
  }
})
