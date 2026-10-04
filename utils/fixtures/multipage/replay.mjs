// Run from the repository root; see README.md for the pinned viewer setup.
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import AdmZip from 'adm-zip'
import { WARCParser } from 'warcio'
import { Scoop } from '../../../Scoop.js'
import { payloadDeduplicator } from '../../../exporters/payload-deduplication.js'

const directory = resolve(process.argv[2] || 'tmp/multipage-validation')
const viewer = join(directory, 'replay')
assert.equal(JSON.parse(await readFile(join(viewer, 'package.json'))).version, '2.5.3')
await mkdir(directory, { recursive: true })
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
const hash = data => createHash('sha256').update(data).digest('hex')
const hits = []
const logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">' + Array.from({ length: 4096 }, (_, i) => `<rect x="${i % 64 * 2}" y="${Math.floor(i / 64) * 2}" width="2" height="2" fill="#${hash(String(i)).slice(0, 6)}"/>`).join('') + '</svg>')
const html = Buffer.from(`<!doctype html><title>Offline fixture</title><link rel="icon" href="data:,"><h1></h1><img id="logo" src="/logo.svg"><a id="next">Next page</a><pre id="variant"></pre><script>
document.querySelector('h1').textContent = 'Archived ' + location.pathname;
document.querySelector('#next').href = location.pathname === '/a' ? '/b' : '/a';
document.cookie = 'variant=' + location.pathname.slice(1) + '; path=/';
fetch('/variant').then(r => r.text()).then(s => document.querySelector('#variant').textContent = s);
</script>`)
let timing
let firstRequestTime
const origin = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (req.method === 'HEAD' && url.pathname === '/a' && timing === 'same-second') {
    // Align the fixture with a UTC boundary without editing captured timestamps.
    await new Promise(resolve => setTimeout(resolve, 1000 - Date.now() % 1000 + 10))
  }
  if (req.method === 'GET' && url.pathname === '/a') firstRequestTime = Date.now()
  if (req.method === 'HEAD' && url.pathname === '/b' && timing === 'separate-seconds') {
    const boundary = Math.floor(firstRequestTime / 1000) * 1000 + 1100
    if (Date.now() < boundary) await new Promise(resolve => setTimeout(resolve, boundary - Date.now()))
  }
  hits.push({ timing, url: url.pathname, method: req.method, cookie: req.headers.cookie || null })
  const body = url.pathname === '/logo.svg' ? logo : url.pathname === '/variant' ? Buffer.from(req.headers.cookie || 'none') : html
  res.writeHead(200, { 'content-type': url.pathname === '/logo.svg' ? 'image/svg+xml' : url.pathname === '/variant' ? 'text/plain' : 'text/html', 'content-length': body.length, 'cache-control': 'max-age=3600', 'x-observation': String(hits.length) })
  res.end(body)
})
const base = await listen(origin)
const options = { logLevel: 'silent', blocklist: [], proxyPort: 0, chromiumSandbox: true, captureTimeout: 30000, screenshot: true, domSnapshot: true, pdfSnapshot: false, captureVideoAsAttachment: false, captureCertificatesAsAttachment: false, provenanceSummary: false, autoScroll: false, autoPlayMedia: false, grabSecondaryResources: false, runSiteSpecificBehaviors: false }
const outputs = []
const evidence = { viewer: 'ReplayWeb.page 2.5.3', node: process.version, versions: process.versions, origin: base, sizes: [], replay: [], hits }
let browser
let host
try {
  const cases = [false, true].flatMap(deduplicatePayloads => ['same-second', 'separate-seconds'].map(timing => ({ deduplicatePayloads, timing })))
  for (const scenario of cases) {
    const { deduplicatePayloads } = scenario
    timing = scenario.timing
    const capture = await Scoop.capture([base + '/a', base + '/b'], { ...options, deduplicatePayloads })
    assert.equal(capture.state, Scoop.states.COMPLETE)
    const summary = await capture.summary()
    const prefix = (deduplicatePayloads ? 'deduplicated' : 'full') + '-' + timing
    await writeFile(join(directory, prefix + '.json'), JSON.stringify(summary, null, 2))
    const warc = Buffer.from(await capture.toWARC())
    await writeFile(join(directory, prefix + '.warc'), warc)
    const records = []
    for await (const record of new WARCParser([warc])) {
      if (!['response', 'revisit'].includes(record.warcType)) continue
      const body = Buffer.from(await record.readFully(false))
      records.push({ url: record.warcTargetURI, date: record.warcDate, type: record.warcType, id: record.warcHeader('WARC-Record-ID'), ref: record.warcHeader('WARC-Refers-To'), observation: record.httpHeaders?.headers.get('x-observation'), length: body.length, hash: hash(body) })
    }
    const variants = records.filter(r => r.url === base + '/variant')
    assert.equal(variants.length, 2)
    assert.notEqual(variants[0].hash, variants[1].hash)
    assert.ok(variants.every(r => r.type === 'response'))
    assert.equal(variants[0].date.slice(0, 19) === variants[1].date.slice(0, 19), timing === 'same-second', 'fixture must exercise its specified index-resolution case')
    const intercepted = capture.exchanges.filter(ex => ex.request && ex.response)
    const eligibility = payloadDeduplicator(intercepted)
    const eligible = intercepted.filter(ex => eligibility.candidate(ex)).length
    if (deduplicatePayloads) {
      assert.ok(records.some(r => r.url === base + '/b' && r.type === 'revisit'))
      assert.ok(records.some(r => r.url === base + '/logo.svg' && r.type === 'revisit'))
    }
    await writeFile(join(directory, prefix + '-records.json'), JSON.stringify(records, null, 2))
    for (const raw of [false, true]) {
      const name = `${prefix}-${raw ? 'raw' : 'replay'}.wacz`
      const bytes = Buffer.from(await capture.toWACZ(raw))
      await writeFile(join(directory, name), bytes)
      const zip = new AdmZip(bytes)
      const metadata = JSON.parse(zip.readAsText('datapackage.json'))
      assert.deepEqual(metadata.extras.multipage, summary.multipage)
      assert.equal(zip.getEntries().some(e => e.entryName.startsWith('raw/')), raw)
      outputs.push({ name, pages: summary.multipage.pages })
      evidence.sizes.push({ name, eligibleResponses: eligible, interceptedResponses: intercepted.length, sha256: hash(bytes), waczBytes: bytes.length, warcBytes: warc.length, storedResponsePayloadBytes: records.reduce((n, r) => n + r.length, 0) })
    }
  }
  assert.equal(hits.filter(h => h.method === 'GET' && h.url === '/logo.svg').length, 8)
  await close(origin)
  // Only the local viewer/archive server remains available during replay.
  host = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/') {
        res.setHeader('content-type', 'text/html')
        res.end(`<script src="/ui.js"></script><replay-web-page style="display:block;height:720px" loading="eager" source="/${url.searchParams.get('archive')}" url="${url.searchParams.get('url')}" ts="${url.searchParams.get('ts')}" replayBase="/replay/" embed="replayonly"></replay-web-page>`)
        return
      }
      const allowed = new Map([['/ui.js', join(viewer, 'ui.js')], ['/replay/sw.js', join(viewer, 'sw.js')], ...outputs.map(o => ['/' + o.name, join(directory, o.name)])])
      if (!allowed.has(url.pathname)) { res.writeHead(404); res.end(); return }
      const body = await readFile(allowed.get(url.pathname))
      res.setHeader('content-type', url.pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
      res.setHeader('accept-ranges', 'bytes')
      const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
      const start = match ? Number(match[1]) : 0
      const end = match?.[2] ? Number(match[2]) : body.length - 1
      if (match) { res.statusCode = 206; res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`) }
      res.setHeader('content-length', end - start + 1)
      res.end(body.subarray(start, end + 1))
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  const hostURL = await listen(host)
  browser = await chromium.launch({ chromiumSandbox: true })
  evidence.chromium = browser.version()
  for (const output of outputs) {
    for (const target of output.pages) {
      const context = await browser.newContext()
      const liveRequests = []
      context.on('request', req => { if (req.url().startsWith(base)) liveRequests.push(req.url()) })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(String(error)))
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
      await page.goto(hostURL + '/?' + new URLSearchParams({ archive: output.name, url: target.requestedUrl, ts: target.entryPoint.ts.replace(/[^0-9]/g, '').slice(0, 14) }))
      let replay
      try {
        await page.waitForFunction(() => document.querySelector('replay-web-page')?.shadowRoot, { timeout: 20000 })
        // Frame events are driven by the local service worker, with no origin access.
        replay = page.frames().find(f => f.url().includes('/http://')) ||
          await page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/http://'), timeout: 20000 })
        assert.ok(replay, 'replay frame must be present')
        await replay.locator('h1').waitFor({ timeout: 20000 })
        assert.equal(await replay.locator('h1').innerText(), 'Archived ' + new URL(target.requestedUrl).pathname)
        await replay.waitForFunction(() => document.querySelector('#logo').naturalWidth === 128 && document.querySelector('#variant').textContent.length > 0)
        const variant = await replay.locator('#variant').innerText()
        evidence.replay.push({ archive: output.name, requested: target.requestedUrl, variant, expectedVariant: 'variant=' + new URL(target.requestedUrl).pathname.slice(1), liveRequests })
        assert.deepEqual(liveRequests, [])
        await page.screenshot({ path: join(directory, `${output.name}-${target.id}.png`) })
        await replay.locator('#next').click()
        await replay.waitForFunction(expected => document.querySelector('h1')?.textContent === expected, 'Archived ' + (target.requestedUrl.endsWith('/a') ? '/b' : '/a'))
        assert.deepEqual(liveRequests, [])
      } catch (error) {
        console.error('Replay errors:', errors)
        console.error('Replay frames:', page.frames().map(f => f.url()))
        await page.screenshot({ path: join(directory, 'replay-failure.png') })
        throw error
      } finally { await context.close() }
    }
  }
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser?.close()
  if (host) await close(host)
  if (origin.listening) await close(origin)
}
