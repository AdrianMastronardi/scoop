import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import AdmZip from 'adm-zip'
import StreamZip from 'node-stream-zip'
import { WARCParser, WARCSerializer } from 'warcio'
import { Scoop } from './Scoop.js'

const options = {
  logLevel: 'silent',
  blocklist: [],
  proxyPort: 0,
  chromiumSandbox: true,
  screenshot: false,
  domSnapshot: false,
  pdfSnapshot: false,
  captureVideoAsAttachment: false,
  captureCertificatesAsAttachment: false,
  provenanceSummary: false,
  autoScroll: false,
  autoPlayMedia: false,
  grabSecondaryResources: false,
  runSiteSpecificBehaviors: false,
  captureTimeout: 20000,
  loadTimeout: 3000,
  networkIdleTimeout: 1000
}

async function fixture (t, handle) {
  const hits = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    hits.push({ path: url.pathname, method: req.method, cookie: req.headers.cookie })
    if (handle?.(req, res, url)) return
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/a', 'content-length': '0' }); res.end(); return
    }
    if (url.pathname === '/broken-redirect') {
      res.writeHead(302, { location: '/broken', 'content-length': '0' }); res.end(); return
    }
    if (url.pathname === '/broken') { req.socket.destroy(); return }
    if (url.pathname === '/blocked-redirect') {
      res.writeHead(302, { location: '/private', 'content-length': '0' }); res.end(); return
    }
    if (url.pathname === '/ip') { res.end('192.0.2.1'); return }
    if (url.pathname === '/popup') {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>Consent window</title><p>Choose your preferences</p>'); return
    }
    if (url.pathname === '/opener') {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>Consent banner</title><div id="consent">Choose cookies</div><iframe src="/popup"></iframe><script>window.open("/popup")</script>'); return
    }
    if (url.pathname === '/resource') {
      const body = Buffer.alloc(32768, 65)
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length, 'cache-control': 'max-age=3600', 'x-observation': String(hits.length) })
      res.end(body); return
    }
    if (url.pathname === '/binary') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 4 }); res.end('DATA'); return
    }
    const body = `<!doctype html><title>${url.pathname}</title><link rel="icon" href="data:,"><p>${url.pathname}</p><script>
      if (location.pathname === '/a') { document.cookie='shared=yes; path=/'; localStorage.setItem('shared','yes'); sessionStorage.setItem('private','yes') }
      document.title += '|' + localStorage.getItem('shared') + '|' + sessionStorage.getItem('private')
      fetch('/resource').then(r => r.text()).then(s => document.body.dataset.resource=s.slice(0,1))
      </script>`
    res.writeHead(url.pathname === '/missing' ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.closeAllConnections(); server.close() })
  return { base: `http://127.0.0.1:${server.address().port}`, hits }
}

async function archive (t, capture, raw = true) {
  const dir = await mkdtemp(join(tmpdir(), 'scoop-multipage-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'capture.wacz')
  await writeFile(path, Buffer.from(await capture.toWACZ(raw)))
  const zip = new StreamZip.async({ file: path }) // eslint-disable-line
  t.after(() => zip.close())
  return { zip, path }
}

test('array inputs validate before setup and copy the requested plan', () => {
  for (const invalid of [[], new Array(2), [''], [' https://example.com'], [null], [12], [['https://example.com']], [new String('https://example.com')], ['ftp://example.com'], ['https://u:p@example.com']]) { // eslint-disable-line no-new-wrappers
    assert.throws(() => new Scoop(invalid, options), /URL|array|index/)
  }
  assert.throws(() => new Scoop(['https://example.com', 'https://example.com/'], options), /index 1.*index 0/)
  for (const value of [null, 'true', 1, new Boolean(true), undefined]) { // eslint-disable-line no-new-wrappers
    assert.throws(() => new Scoop('https://example.com', { ...options, deduplicatePayloads: value }), /primitive boolean/)
  }
  const urls = ['https://example.com/a#one', 'https://example.com/a#two']
  const capture = new Scoop(urls, options)
  urls[0] = 'https://changed.example/'
  capture.multipage.urls[0] = 'https://mutated.example/'
  assert.equal(capture.url, 'https://example.com/a#one')
  assert.equal(capture.multipage.urls[0], capture.url)
  assert.equal(new Scoop('https://example.com', options).multipage, undefined)
  assert.throws(() => new Scoop(['http://127.0.0.1/'], { ...options, blocklist: ['http://127.0.0.1/'] }), /index 0/)
})

test('sequential pages share origin storage, bypass cache and export/reconstruct their own artifacts', { timeout: 60000 }, async t => {
  const { base, hits } = await fixture(t)
  const capture = new Scoop([base + '/redirect#first', base + '/b', base + '/missing'], { ...options, screenshot: true, domSnapshot: true, pdfSnapshot: true })
  await capture.capture()
  assert.equal(capture.state, Scoop.states.COMPLETE)
  const { multipage } = await capture.summary()
  assert.equal(multipage.pages.length, 3)
  assert.equal(multipage.pages[0].resolvedUrl, base + '/a')
  assert.equal(multipage.pages[0].entryPoint.url, base + '/redirect#first')
  assert.match(multipage.pages[1].pageInfo.title, /yes\|null$/)
  assert.equal(multipage.pages[2].httpStatus, 404)
  assert.equal(hits.filter(hit => hit.path === '/resource').length, 3)
  assert.ok(hits.find(hit => hit.path === '/b' && hit.method === 'GET').cookie.includes('shared=yes'))
  for (const page of multipage.pages) {
    assert.equal(page.outcome, 'complete')
    assert.equal(page.attachments.screenshot, `${page.id}-screenshot.png`)
    assert.equal(page.attachments.domSnapshot, `${page.id}-dom-snapshot.html`)
    assert.equal(page.attachments.pdfSnapshot, `${page.id}-pdf-snapshot.pdf`)
    assert.ok(page.steps.every(step => step.pageId === page.id))
  }
  const { zip, path } = await archive(t, capture)
  const metadata = JSON.parse(await zip.entryData('datapackage.json'))
  assert.deepEqual(metadata.extras.multipage, multipage)
  assert.equal(metadata.mainPageUrl, base + '/redirect#first')
  const reconstructed = await Scoop.fromWACZ(path)
  assert.equal(reconstructed.state, Scoop.states.RECONSTRUCTED)
  assert.equal(reconstructed.url, capture.url)
  assert.deepEqual(reconstructed.multipage, multipage)
  const records = []
  for await (const record of new WARCParser([await reconstructed.toWARC()])) {
    records.push({ page: record.warcHeader('Scoop-Page-ID'), url: record.warcTargetURI })
  }
  assert.ok(records.some(record => record.page === 'page-0002' && record.url === 'file:///page-0002-screenshot.png'))
  multipage.pages[0].entryPoint.url = 'https://mutated.example/'
  multipage.pages[0].steps[0].name = 'changed'
  assert.notEqual(capture.multipage.pages[0].entryPoint.url, 'https://mutated.example/')
  const fresh = await Scoop.capture([base + '/b'], options)
  assert.match(fresh.multipage.pages[0].pageInfo.title, /null\|null$/)
})

test('non-web targets remain partial and do not stop later pages', { timeout: 30000 }, async t => {
  const { base } = await fixture(t)
  const capture = await Scoop.capture([base + '/a', base + '/binary', base + '/b'], options)
  assert.equal(capture.state, Scoop.states.PARTIAL)
  assert.deepEqual(capture.multipage.pages.map(p => p.outcome), ['complete', 'partial', 'complete'])
  assert.equal(capture.multipage.pages[1].reason, 'non_web_capture')
  assert.equal(capture.multipage.pages[1].entryPoint.url, base + '/binary')
})

test('broken redirects preserve baseline outcomes without advertising an uncaptured destination', { timeout: 30000 }, async t => {
  const { base } = await fixture(t)
  const capture = await Scoop.capture([base + '/broken-redirect', base + '/b'], options)
  assert.equal(capture.multipage.pages[0].outcome, 'complete')
  assert.equal(capture.multipage.pages[0].entryPoint, null)
  assert.equal(capture.multipage.pages[0].httpStatus, 302)
  const { zip } = await archive(t, capture, false)
  assert.equal(JSON.parse(await zip.entryData('datapackage.json')).mainPageUrl, base + '/b')
})

test('opt-in deduplication preserves requests, observation headers and complete raw reconstruction', { timeout: 40000 }, async t => {
  const { base } = await fixture(t)
  const capture = await Scoop.capture([base + '/a', base + '/b'], { ...options, deduplicatePayloads: true })
  const records = []
  for await (const record of new WARCParser([await capture.toWARC()])) {
    const body = Buffer.from(await record.readFully(false))
    if (record.warcTargetURI === base + '/resource') records.push({ type: record.warcType, ref: record.warcHeader('WARC-Refers-To'), id: record.warcHeader('WARC-Record-ID'), body, header: record.httpHeaders?.headers.get('x-observation') })
  }
  assert.deepEqual(records.map(r => r.type), ['request', 'response', 'request', 'revisit'])
  assert.equal(records[3].ref, records[1].id)
  assert.notEqual(records[3].header, records[1].header)
  assert.equal(records[3].body.length, 0)
  const { path } = await archive(t, capture)
  const restored = await Scoop.fromWACZ(path)
  for (const ex of capture.exchanges.filter(ex => ex.requestRaw)) {
    const copy = restored.exchanges.find(copy => copy.id === ex.id)
    assert.deepEqual(copy.requestRaw, ex.requestRaw)
    assert.deepEqual(copy.responseRaw, ex.responseRaw)
  }
  assert.equal(restored.options.deduplicatePayloads, false)
})

function configurePages (t, configure) {
  const launch = chromium.launch.bind(chromium)
  let browserCount = 0
  let contextCount = 0
  const pages = []
  t.mock.method(chromium, 'launch', async options => {
    browserCount++
    const browser = await launch(options)
    const newContext = browser.newContext.bind(browser)
    t.mock.method(browser, 'newContext', async options => {
      contextCount++
      const context = await newContext(options)
      context.on('page', page => { pages.push(page); configure(page, pages.length, browser) })
      return context
    })
    return browser
  })
  return { pages, counts: () => [browserCount, contextCount] }
}

test('ordinary artifact failures preserve baseline completion and a failed first attempt does not stop the list', { timeout: 30000 }, async t => {
  const { base } = await fixture(t)
  const observed = configurePages(t, (page, index) => {
    if (index === 1) t.mock.method(page, 'goto', async () => { throw new Error('fixture navigation failure') })
    t.mock.method(page, 'screenshot', async () => { throw new Error('fixture screenshot failure') })
  })
  const capture = await Scoop.capture([base + '/a', base + '/b'], { ...options, screenshot: true })
  assert.equal(capture.state, Scoop.states.PARTIAL)
  assert.equal(capture.url, base + '/a')
  assert.deepEqual(capture.multipage.pages.map(p => p.outcome), ['failed', 'complete'])
  assert.equal(capture.multipage.pages[0].reason, 'navigation_error')
  assert.ok(capture.multipage.pages[1].steps.some(s => s.name === 'Screenshot' && s.outcome === 'failed'))
  assert.deepEqual(observed.counts(), [1, 1])
  assert.ok(observed.pages.every(page => page.isClosed()))
  const { zip, path } = await archive(t, capture)
  assert.equal(JSON.parse(await zip.entryData('datapackage.json')).mainPageUrl, base + '/b')
  assert.equal((await Scoop.fromWACZ(path)).url, base + '/a')
})

test('shared size budget stops later pages and preserves earlier evidence', { timeout: 30000 }, async t => {
  const { base, hits } = await fixture(t)
  const capture = await Scoop.capture([base + '/a', base + '/b', base + '/missing'], { ...options, maxCaptureSize: 50000 })
  assert.equal(capture.state, Scoop.states.PARTIAL)
  const pages = capture.multipage.pages
  assert.deepEqual(pages.map(p => p.outcome), ['complete', 'partial', 'skipped'])
  assert.equal(pages[1].reason, 'capture_size_limit')
  assert.equal(pages[2].reason, 'capture_size_limit')
  assert.ok(!hits.some(hit => hit.path === '/missing'))
})

test('auxiliary consent windows remain visible during their attempt and are closed before the next', { timeout: 30000 }, async t => {
  const { base, hits } = await fixture(t)
  const observed = configurePages(t, () => {})
  const capture = await Scoop.capture([base + '/opener', base + '/b'], { ...options, domSnapshot: true })
  assert.equal(capture.state, Scoop.states.COMPLETE)
  assert.equal(capture.multipage.pages.length, 2)
  assert.ok(hits.filter(h => h.path === '/popup').length >= 2)
  const dom = capture.exchanges.find(e => e.url === 'file:///page-0001-dom-snapshot.html').response.body.toString()
  assert.match(dom, /Choose cookies/)
  assert.ok(observed.pages.length >= 3)
  assert.ok(observed.pages.every(p => p.isClosed()))
  assert.deepEqual(observed.counts(), [1, 1])
})

test('snapshot deadline on the second page preserves results and skips the third', { timeout: 30000 }, async t => {
  const { base, hits } = await fixture(t)
  configurePages(t, (page, index) => {
    if (index === 2) t.mock.method(page, 'pdf', () => new Promise(() => {}))
  })
  const capture = await Scoop.capture([base + '/a', base + '/b', base + '/missing'], { ...options, pdfSnapshot: true, provenanceSummary: true, publicIpResolverEndpoint: base + '/ip' })
  assert.equal(capture.state, Scoop.states.PARTIAL)
  assert.deepEqual(capture.multipage.pages.map(p => p.outcome), ['complete', 'partial', 'skipped'])
  assert.equal(capture.multipage.pages[1].reason, 'snapshot_timeout')
  assert.equal(capture.multipage.pages[2].reason, 'session_failed')
  assert.ok(!hits.some(hit => hit.path === '/missing'))
  assert.ok(capture.exchanges.some(e => e.url === 'file:///provenance-summary.html'))
  assert.deepEqual(capture.provenanceInfo.multipage, capture.multipage)
})

test('provenance and signatures cover the fixed inventory and actual ZIP resources', { timeout: 30000 }, async t => {
  const { base } = await fixture(t)
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  let signedHash
  const signer = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const { hash, created } = JSON.parse(body)
    signedHash = hash
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ hash, created, software: 'local test', publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signature: sign('sha256', Buffer.from(hash), privateKey).toString('base64') }))
  })
  await new Promise(resolve => signer.listen(0, '127.0.0.1', resolve))
  t.after(() => { signer.closeAllConnections(); signer.close() })
  const capture = await Scoop.capture([base + '/a', base + '/b'], { ...options, provenanceSummary: true, publicIpResolverEndpoint: base + '/ip' })
  const bytes = await capture.toWACZ(true, { url: `http://127.0.0.1:${signer.address().port}/sign` })
  const zip = new AdmZip(Buffer.from(bytes))
  const manifestBytes = zip.readFile('datapackage.json')
  const manifest = JSON.parse(manifestBytes)
  const digest = JSON.parse(zip.readAsText('datapackage-digest.json'))
  const hash = data => 'sha256:' + createHash('sha256').update(data).digest('hex')
  assert.equal(hash(manifestBytes), signedHash)
  assert.equal(digest.hash, signedHash)
  assert.ok(verify('sha256', Buffer.from(signedHash), publicKey, Buffer.from(digest.signedData.signature, 'base64')))
  for (const resource of manifest.resources) {
    const data = zip.readFile(resource.path)
    assert.equal(hash(data), resource.hash)
    assert.equal(data.length, resource.bytes)
  }
  assert.deepEqual(manifest.extras.multipage, capture.multipage)
  assert.deepEqual(capture.provenanceInfo.multipage, capture.multipage)
  const global = capture.steps.find(s => s.name === 'Provenance summary')
  assert.ok(Date.parse(global.startedAt) >= Date.parse(capture.multipage.finishedAt))
  manifest.extras.multipage.pages[0].pageInfo.title = 'tampered'
  assert.ok(!verify('sha256', Buffer.from(hash(Buffer.from(JSON.stringify(manifest)))), publicKey, Buffer.from(digest.signedData.signature, 'base64')))
  const pagesResource = manifest.resources.find(r => r.path.includes('pages.jsonl'))
  assert.notEqual(hash(Buffer.concat([zip.readFile(pagesResource.path), Buffer.from('tampered')])), pagesResource.hash)
})

test('reconstruction rejects malformed multipage metadata and missing artifact associations', { timeout: 30000 }, async t => {
  const { base } = await fixture(t)
  const capture = await Scoop.capture([base + '/a', base + '/b'], { ...options, screenshot: true })
  const bytes = Buffer.from(await capture.toWACZ(true))
  const directory = await mkdtemp(join(tmpdir(), 'scoop-multipage-invalid-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const mutations = [
    data => { data.version = 4 },
    data => { data.urls.pop() },
    data => { data.pages[0].id = 'page-00001' },
    data => { data.pages[0].outcome = 'capturing' },
    data => { data.pages[0].startedAt = '2026-02-31T00:00:00Z' },
    data => { data.pages[0].steps[0].pageId = 'page-0002' },
    data => { data.pages[0].entryPoint.url = base + '/other' },
    data => { data.pages[0].attachments.screenshot = '../outside.png' },
    data => { data.pages[0].attachments.screenshot = 'missing.png' },
    data => { data.pages[0].attachments.screenshot = 'page-0002-screenshot.png' },
    data => { data.pages[0].steps[1].id = data.pages[0].steps[0].id }
  ]
  for (const [index, mutate] of mutations.entries()) {
    const zip = new AdmZip(bytes)
    const manifest = JSON.parse(zip.readAsText('datapackage.json'))
    mutate(manifest.extras.multipage)
    zip.updateFile('datapackage.json', Buffer.from(JSON.stringify(manifest)))
    const path = join(directory, `${index}.wacz`)
    await writeFile(path, zip.toBuffer())
    await assert.rejects(Scoop.fromWACZ(path), /multipage|URL|artifact/i)
  }
})

test('a shared deadline interrupts page two and settles its work before cleanup', { timeout: 15000 }, async t => {
  const { base, hits } = await fixture(t)
  let settled = false
  const observed = configurePages(t, (page, index) => {
    if (index === 2) t.mock.method(page, 'waitForLoadState', () => new Promise(resolve => page.once('close', () => { settled = true; resolve() })))
  })
  const capture = await Scoop.capture([base + '/a', base + '/b', base + '/missing'], { ...options, captureTimeout: 3000, networkIdleTimeout: 1, attachmentsBypassLimits: false })
  assert.equal(capture.state, Scoop.states.PARTIAL)
  assert.deepEqual(capture.multipage.pages.map(p => p.outcome), ['complete', 'partial', 'skipped'])
  assert.equal(capture.multipage.pages[1].reason, 'capture_timeout')
  assert.equal(capture.multipage.pages[2].reason, 'capture_timeout')
  assert.ok(settled)
  assert.ok(observed.pages.every(p => p.isClosed()))
  assert.ok(!hits.some(h => h.path === '/missing'))
  await assert.rejects(access(capture.captureTmpFolderPath))
})

test('generated artifacts consume a cumulative budget when bypass is disabled', { timeout: 15000 }, async t => {
  const { base } = await fixture(t)
  configurePages(t, page => {
    const screenshot = page.screenshot.bind(page)
    t.mock.method(page, 'screenshot', async options => Buffer.concat([await screenshot(options), Buffer.alloc(60000)]))
  })
  const capture = await Scoop.capture([base + '/a', base + '/b', base + '/missing'], { ...options, screenshot: true, attachmentsBypassLimits: false, maxCaptureSize: 140000 })
  assert.deepEqual(capture.multipage.pages.map(p => p.outcome), ['complete', 'partial', 'skipped'])
  assert.equal(capture.multipage.pages[1].reason, 'capture_size_limit')
  assert.ok(capture.multipage.pages[0].attachments.screenshot)
  assert.ok(!capture.multipage.pages[1].attachments.screenshot)
})

test('shared setup failure records every skipped target without starting Chromium', async t => {
  const capture = new Scoop(['https://example.com/a', 'https://example.com/b'], options)
  t.mock.method(capture.intercepter, 'setup', async () => { throw new Error('fixture setup failure') })
  t.mock.method(chromium, 'launch', () => assert.fail('must not launch'))
  await capture.capture()
  assert.equal(capture.state, Scoop.states.FAILED)
  assert.deepEqual(capture.multipage.pages.map(p => p.reason), ['shared_setup_failed', 'shared_setup_failed'])
  assert.ok(capture.multipage.pages.every(p => p.startedAt === null && p.steps.length === 0))
  await assert.rejects(access(capture.captureTmpFolderPath))
})

test('session loss keeps earlier pages and skips later targets', { timeout: 15000 }, async t => {
  const { base, hits } = await fixture(t)
  configurePages(t, (page, index, browser) => {
    if (index === 2) t.mock.method(page, 'waitForLoadState', async () => { await browser.close() })
  })
  const capture = await Scoop.capture([base + '/a', base + '/b', base + '/missing'], options)
  assert.equal(capture.state, Scoop.states.PARTIAL)
  assert.deepEqual(capture.multipage.pages.map(p => p.outcome), ['complete', 'failed', 'skipped'])
  assert.equal(capture.multipage.pages[2].reason, 'session_failed')
  assert.ok(!hits.some(h => h.path === '/missing'))
})

test('video helpers use isolated directories and namespaced links for each page', { timeout: 20000 }, async t => {
  const { base } = await fixture(t)
  const directory = await mkdtemp(join(tmpdir(), 'scoop-video-multipage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const helper = join(directory, 'yt-dlp')
  await writeFile(helper, `#!${process.execPath}
const fs = require('node:fs')
if (process.argv.includes('--version')) { console.log('2026.10.03'); process.exit(0) }
const output = process.argv[process.argv.indexOf('--output') + 1].replace('%(autonumber)d', '1')
fs.writeFileSync(output, process.argv.at(-1))
fs.writeFileSync(output.replace('.mp4', '.en.vtt'), 'WEBVTT')
console.log(JSON.stringify({ title: 'fixture', filename: output }))
`, { mode: 0o755 })
  const capture = await Scoop.capture([base + '/a', base + '/b'], { ...options, captureVideoAsAttachment: true, ytDlpPath: helper })
  for (const [i, row] of capture.multipage.pages.entries()) {
    const summary = capture.exchanges.find(e => e.url === `file:///${row.id}-video-extracted-summary.html`).response.body.toString()
    assert.ok(summary.includes(`${row.id}-video-extracted-1.mp4`))
    assert.ok(summary.includes(`${row.id}-video-extracted-1.en.vtt`))
    assert.ok(summary.includes(`${row.id}-video-extracted-metadata.json`))
    assert.equal(capture.exchanges.find(e => e.url === `file:///${row.id}-video-extracted-1.mp4`).response.body.toString(), base + (i ? '/b' : '/a'))
  }
  assert.equal(capture.state, Scoop.states.COMPLETE)
})

test('multipage serialization failures stop WACZ before signing', { timeout: 15000 }, async t => {
  const { base } = await fixture(t)
  const capture = await Scoop.capture([base + '/a'], options)
  const serialize = WARCSerializer.serialize.bind(WARCSerializer)
  t.mock.method(WARCSerializer, 'serialize', async (record, options) => {
    if (record.warcType === 'response') throw new Error('fixture serialization failure')
    return serialize(record, options)
  })
  await assert.rejects(capture.toWACZ(false, { url: base + '/sign-must-not-run' }), /fixture serialization failure/)
})

test('CLI preserves multiple positional URLs, partial exit 0, failed summaries and distinct attachments', { timeout: 30000 }, async t => {
  const { base } = await fixture(t)
  const directory = await mkdtemp(join(tmpdir(), 'scoop-multi-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'capture.wacz')
  const summary = join(directory, 'summary.json')
  const args = ['--blocklist', '', '--proxy-port', '0', '--log-level', 'silent', '--capture-video-as-attachment', 'false', '--capture-certificates-as-attachment', 'false', '--provenance-summary', 'false', '--auto-scroll', 'false', '--auto-play-media', 'false', '--grab-secondary-resources', 'false', '--run-site-specific-behaviors', 'false', '--json-summary-output', summary, '--output', output, '--load-timeout', '2000']
  await promisify(execFile)(process.execPath, ['bin/cli.js', base + '/a', base + '/binary', base + '/b', '--deduplicate-payloads', '--export-attachments-output', directory, ...args])
  const data = JSON.parse(await readFile(summary))
  assert.equal(data.state, Scoop.states.PARTIAL)
  assert.deepEqual(data.multipage.urls, [base + '/a', base + '/binary', base + '/b'])
  assert.equal(data.options.deduplicatePayloads, true)
  await access(join(directory, 'page-0001-screenshot.png'))
  await access(join(directory, 'page-0003-screenshot.png'))
  await assert.rejects(promisify(execFile)(process.execPath, ['bin/cli.js', 'http://127.0.0.1:9/a', 'http://127.0.0.1:9/b', ...args]), error => error.code === 1)
  assert.deepEqual(JSON.parse(await readFile(summary)).multipage.pages.map(p => p.outcome), ['failed', 'failed'])
})

test('a suspended video helper cannot resume recording or admit another target after a shared stop', { timeout: 15000 }, async t => {
  const { base, hits } = await fixture(t, (req, res, url) => {
    if (url.pathname !== '/stop') return false
    capture.stopRecording('capture_timeout')
    res.end('stopped')
    return true
  })
  const directory = await mkdtemp(join(tmpdir(), 'scoop-video-stop-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const helper = join(directory, 'yt-dlp')
  await writeFile(helper, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2026.10.03'); process.exit(0) }
require('node:http').get('${base}/stop', res => { res.resume(); res.on('end', () => console.log('{}')) })
`, { mode: 0o755 })
  const capture = new Scoop([base + '/a', base + '/b'], { ...options, captureVideoAsAttachment: true, ytDlpPath: helper })
  await capture.capture()
  assert.equal(capture.intercepter.recordExchanges, false)
  assert.deepEqual(capture.multipage.pages.map(p => p.outcome), ['partial', 'skipped'])
  assert.ok(!hits.some(h => h.path === '/b'))
})

test('redirect policy errors do not invent origin responses and captures without entries omit replay hints', { timeout: 15000 }, async t => {
  const { base, hits } = await fixture(t)
  const capture = await Scoop.capture([base + '/blocked-redirect'], { ...options, blocklist: ['/private/'], screenshot: true })
  const row = capture.multipage.pages[0]
  assert.equal(row.httpStatus, 302)
  assert.equal(row.entryPoint, null)
  assert.ok(!hits.some(h => h.path === '/private'))
  assert.equal(capture.state, Scoop.states.COMPLETE)
  const { zip, path } = await archive(t, capture)
  const metadata = JSON.parse(await zip.entryData('datapackage.json'))
  assert.ok(!('mainPageUrl' in metadata))
  assert.ok(!('mainPageDate' in metadata))
  assert.deepEqual((await Scoop.fromWACZ(path)).multipage, capture.multipage)
})

test('a size limit during network idle still permits the current screenshot when attachments bypass limits', { timeout: 20000 }, async t => {
  let stream
  let ready
  const streaming = new Promise(resolve => { ready = resolve })
  const { base } = await fixture(t, (req, res, url) => {
    if (url.pathname === '/stream') {
      stream = res
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000000' })
      res.flushHeaders()
      ready()
      return true
    }
    if (url.pathname === '/streaming-page') {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>Streaming fixture</title><link rel="icon" href="data:,"><h1>Retain this screenshot</h1><script>fetch("/stream")</script>')
      return true
    }
    return false
  })
  configurePages(t, page => {
    const wait = page.waitForLoadState.bind(page)
    t.mock.method(page, 'waitForLoadState', async (...args) => {
      await streaming
      stream.write(Buffer.alloc(10000))
      return wait(...args)
    })
  })
  const capture = await Scoop.capture([base + '/streaming-page', base + '/b'], { ...options, maxCaptureSize: 5000, networkIdleTimeout: 10000, screenshot: true, autoScroll: true })
  assert.deepEqual(capture.multipage.pages.map(p => p.outcome), ['partial', 'skipped'])
  assert.ok(capture.multipage.pages[0].attachments.screenshot)
  assert.ok(capture.multipage.pages[0].steps.some(s => s.name === 'Browser scripts' && s.outcome === 'completed'))
  assert.ok(capture.multipage.pages[0].steps.some(s => s.name === 'Wait for network idle' && s.outcome === 'interrupted'))
})
