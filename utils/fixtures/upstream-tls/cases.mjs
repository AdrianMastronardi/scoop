import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import http from 'node:http'
import { readFile, mkdtemp, writeFile, rm, access } from 'node:fs/promises'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { WARCParser } from 'warcio'
import { Scoop } from '../../../Scoop.js'
import { NetworkPolicy, fetchHead } from '../../network.js'

const key = await readFile(new URL('./key.pem', import.meta.url))
const certificates = Object.fromEntries(await Promise.all(['valid', 'expired', 'future', 'wrong', 'untrusted'].map(async name =>
  [name, await readFile(new URL(`./${name}.pem`, import.meta.url))])))
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
  captureTimeout: 15000,
  loadTimeout: 3000,
  networkIdleTimeout: 600
}
const html = '<!doctype html><title>Valid origin</title><link rel="icon" href="data:,"><p>Retained document</p>'
const exec = promisify(execFile)

async function fixture (t, certificate = 'valid', handle) {
  const hits = []
  const server = (certificate ? https : http).createServer(certificate ? { key, cert: certificates[certificate] } : {}, (request, response) => {
    hits.push({ method: request.method, path: request.url })
    if (handle?.(request, response, server)) return
    response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(html) })
    response.end(request.method === 'HEAD' ? undefined : html)
  })
  server.on('tlsClientError', () => {})
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { server, hits, base: `${certificate ? 'https' : 'http'}://127.0.0.1:${server.address().port}` }
}

async function directory (t) {
  const path = await mkdtemp(join(tmpdir(), 'scoop-tls-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

async function archive (t, capture) {
  const path = join(await directory(t), 'capture.wacz')
  const data = Buffer.from(await capture.toWACZ(true))
  await writeFile(path, data)
  return { path, zip: new AdmZip(data) }
}

const input = (url, array) => array ? [url] : url

for (const array of [false, true]) {
  const mode = array ? 'one-element array' : 'string'
  test(`${mode}: trusted HTTPS, IP identity and DNS SNI retain valid origin data`, async t => {
    const origin = await fixture(t)
    const sni = []
    origin.server.on('secureConnection', socket => sni.push(socket.servername))
    const url = origin.base.replace('127.0.0.1', 'localhost') + '/'
    const capture = await Scoop.capture(input(url, array), { ...options, screenshot: true, domSnapshot: true })
    assert.equal(capture.state, Scoop.states.COMPLETE)
    assert.deepEqual(capture.errors, [])
    assert.ok(sni.includes('localhost'))
    assert.ok(capture.exchanges.some(ex => ex.response?.body.toString().includes('Retained document')))
    const { path, zip } = await archive(t, capture)
    assert.deepEqual(JSON.parse(zip.readAsText('datapackage.json')).extras.captureErrors, [])
    assert.deepEqual((await Scoop.fromWACZ(path)).errors, [])
    assert.ok(origin.hits.some(hit => hit.method === 'HEAD'))
    assert.ok(origin.hits.some(hit => hit.method === 'GET'))
  })

  for (const [kind, code] of [['untrusted', 'DEPTH_ZERO_SELF_SIGNED_CERT'], ['wrong', 'ERR_TLS_CERT_ALTNAME_INVALID'], ['expired', 'CERT_HAS_EXPIRED'], ['future', 'CERT_NOT_YET_VALID']]) {
    test(`${mode}: HEAD rejects ${kind} certificate without GET fallback`, async t => {
      const origin = await fixture(t, kind)
      const capture = await Scoop.capture(input(origin.base + '/', array), options)
      assert.equal(capture.state, Scoop.states.FAILED)
      assert.equal(capture.errors.length, 1)
      const error = capture.errors[0]
      assert.equal(error.kind, 'tls_validation_failed')
      assert.equal(error.code, code)
      assert.equal(error.phase, 'head')
      assert.equal(error.url, origin.base + '/')
      assert.equal(error.pageId, array ? 'page-0001' : null)
      assert.equal(origin.hits.length, 0)
      capture.stopRecording('capture_timeout')
      assert.equal(capture.state, Scoop.states.FAILED)
      await assert.rejects(access(capture.captureTmpFolderPath), { code: 'ENOENT' })
      assert.ok(!capture.exchanges.some(ex => ex.response))
      assert.ok(!(await capture.summary()).attachments.screenshot)
      if (array) {
        assert.equal(capture.multipage.pages[0].reason, 'tls_validation_failed')
        assert.equal(capture.multipage.pages[0].steps[0].outcome, 'failed')
      }
      await assert.rejects(capture.toWARC())
      await assert.rejects(capture.toWACZ())
      const snapshot = await capture.summary()
      snapshot.errors[0].code = 'changed'
      assert.equal(capture.errors[0].code, code)
    })
  }

  test(`${mode}: proxy rejects invalid certificate after valid HEAD and keeps primary TLS failure`, async t => {
    const origin = await fixture(t, 'valid', (request, response, server) => {
      if (request.method !== 'HEAD') return false
      // The HEAD TLS handshake is already complete. Only later handshakes change.
      server.setSecureContext({ key, cert: certificates.expired })
      response.writeHead(200, { 'content-type': 'text/html', connection: 'close' })
      response.end()
      return true
    })
    const capture = await Scoop.capture(input(origin.base + '/', array), { ...options, screenshot: true, attachmentsBypassLimits: false })
    assert.equal(capture.state, Scoop.states.FAILED)
    assert.deepEqual(origin.hits.map(hit => hit.method), ['HEAD'])
    assert.ok(capture.errors.some(error => error.phase === 'proxy' && error.code === 'CERT_HAS_EXPIRED'))
    assert.ok(capture.errors.every(error => error.url === null || error.url === origin.base + '/'))
    assert.ok(!capture.exchanges.some(ex => ex.response))
    if (array) assert.equal(capture.multipage.pages[0].reason, 'tls_validation_failed')
  })

  test(`${mode}: invalid secondary origin keeps snapshots and an exportable partial result`, async t => {
    const bad = await fixture(t, 'untrusted')
    const body = html + `<img src="${bad.base}/lost.png">`
    const origin = await fixture(t, 'valid', (request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) })
      response.end(request.method === 'HEAD' ? undefined : body)
      return true
    })
    const capture = await Scoop.capture(input(origin.base + '/', array), { ...options, screenshot: true, domSnapshot: true, attachmentsBypassLimits: false })
    assert.equal(capture.state, Scoop.states.PARTIAL)
    assert.equal(bad.hits.length, 0)
    assert.ok(capture.errors.some(error => error.port === Number(new URL(bad.base).port)))
    const summary = await capture.summary()
    assert.ok(summary.attachments.screenshot)
    assert.ok(summary.attachments.domSnapshot)
    if (array) {
      assert.equal(capture.multipage.pages[0].outcome, 'partial')
      assert.equal(capture.multipage.pages[0].reason, 'tls_validation_failed')
      assert.equal(capture.multipage.version, 3)
    }
    const records = []
    for await (const record of new WARCParser([await capture.toWARC()])) {
      records.push({ url: record.warcTargetURI, type: record.warcType, body: Buffer.from(await record.readFully(false)).toString() })
    }
    assert.ok(records.some(record => record.type === 'response' && record.url === origin.base + '/'))
    assert.ok(!records.some(record => record.type === 'response' && record.url?.startsWith(bad.base)))
    const { path, zip } = await archive(t, capture)
    assert.deepEqual(JSON.parse(zip.readAsText('datapackage.json')).extras.captureErrors, capture.errors)
    assert.ok(zip.getEntries().filter(entry => entry.entryName.startsWith('raw/response_')).every(entry => entry.getData().length > 0))
    assert.deepEqual((await Scoop.fromWACZ(path)).errors, capture.errors)
    summary.errors[0].message = 'changed'
    assert.notEqual(capture.errors[0].message, 'changed')
  })

  test(`${mode}: non-web download cannot bypass verification after a valid HEAD`, async t => {
    const origin = await fixture(t, 'valid', (request, response, server) => {
      if (request.method !== 'HEAD') return false
      server.setSecureContext({ key, cert: certificates.wrong })
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 4, connection: 'close' })
      response.end()
      return true
    })
    const capture = await Scoop.capture(input(origin.base + '/', array), options)
    assert.equal(capture.state, Scoop.states.FAILED)
    assert.deepEqual(origin.hits.map(hit => hit.method), ['HEAD'])
    assert.ok(capture.errors.some(error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' && error.phase === 'proxy'))
    if (array) assert.equal(capture.multipage.pages[0].reason, 'tls_validation_failed')
  })
}

test('video helpers reject invalid origins while exchange recording is suspended', async t => {
  const bad = await fixture(t, 'untrusted')
  const good = await fixture(t)
  const helper = join(await directory(t), 'yt-dlp')
  await writeFile(helper, [
    '#!' + process.execPath,
    "const { spawnSync } = require('node:child_process')",
    "if (process.argv.includes('--version')) { console.log('2026.10.03'); process.exit(0) }",
    "const proxy = process.argv[process.argv.indexOf('--proxy') + 1]",
    "const result = spawnSync('curl', ['--silent', '--insecure', '--noproxy', '', '--proxy', proxy, '--max-time', '5', " + JSON.stringify(bad.base + '/video') + '])',
    'process.exit(result.status || 0)'
  ].join('\n'), { mode: 0o755 })
  for (const array of [false, true]) {
    const capture = await Scoop.capture(input(good.base + '/', array), {
      ...options, captureVideoAsAttachment: true, ytDlpPath: helper, screenshot: true
    })
    assert.equal(capture.state, Scoop.states.PARTIAL)
    assert.ok(capture.errors.some(error => error.port === Number(new URL(bad.base).port) && error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT'))
    assert.ok(!capture.exchanges.some(exchange => exchange.url?.startsWith(bad.base)))
    assert.ok((await capture.summary()).attachments.screenshot)
    if (array) assert.equal(capture.multipage.pages[0].reason, 'tls_validation_failed')
  }
  assert.equal(bad.hits.length, 0)
})

test('HEAD redirect reports the failed destination rather than the original target', async t => {
  const bad = await fixture(t, 'expired')
  const origin = await fixture(t, 'valid', (_request, response) => {
    response.writeHead(302, { location: bad.base + '/destination' }); response.end(); return true
  })
  const capture = await Scoop.capture([origin.base + '/'], options)
  assert.equal(capture.state, Scoop.states.FAILED)
  assert.equal(capture.errors[0].url, bad.base + '/destination')
  assert.equal(capture.errors[0].code, 'CERT_HAS_EXPIRED')
  assert.equal(bad.hits.length, 0)
})

test('browser redirect rejects an invalid main destination without attributing a proxy response', async t => {
  const bad = await fixture(t, 'untrusted')
  const origin = await fixture(t, 'valid', (request, response) => {
    if (request.method === 'HEAD') response.writeHead(200, { 'content-type': 'text/html' })
    else response.writeHead(302, { location: bad.base + '/destination', 'content-length': 0 })
    response.end(); return true
  })
  const capture = await Scoop.capture([origin.base + '/'], options)
  assert.equal(capture.state, Scoop.states.FAILED)
  assert.equal(capture.multipage.pages[0].reason, 'tls_validation_failed')
  assert.ok(capture.exchanges.some(ex => ex.response?.startLine.includes('302')))
  assert.ok(!capture.exchanges.some(ex => ex.url.startsWith(bad.base) && ex.response))
  assert.equal(bad.hits.length, 0)
})

test('valid A, TLS-failed B and valid C preserve page outcomes and continue the session', async t => {
  const good = await fixture(t)
  const bad = await fixture(t, 'expired')
  const capture = await Scoop.capture([good.base + '/a', bad.base + '/b', good.base + '/c'], { ...options, screenshot: true })
  assert.equal(capture.state, Scoop.states.PARTIAL)
  assert.deepEqual(capture.multipage.pages.map(page => page.outcome), ['complete', 'failed', 'complete'])
  assert.deepEqual(capture.multipage.pages.map(page => page.reason), [null, 'tls_validation_failed', null])
  assert.equal(capture.errors[0].pageId, 'page-0002')
  assert.ok(capture.multipage.pages[0].attachments.screenshot)
  assert.ok(capture.multipage.pages[2].attachments.screenshot)
  const { path } = await archive(t, capture)
  const restored = await Scoop.fromWACZ(path)
  assert.deepEqual(restored.multipage, capture.multipage)
  assert.deepEqual(restored.errors, capture.errors)
})

test('a certificate failure is not grounds for a second visit, whatever the assessment says', async t => {
  const good = await fixture(t)
  const bad = await fixture(t, 'expired')
  const secondary = await fixture(t, 'valid', (request, response) => {
    const body = `<!doctype html><title>Secondary</title><link rel="icon" href="data:,"><img src="${bad.base}/image.png">`
    response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) })
    response.end(request.method === 'HEAD' ? undefined : body); return true
  })
  // No screenshot is taken: every visit lacks the artifact this capture requires.
  class Requiring extends Scoop {
    async assessPageAttempt () { return { missingArtifacts: ['screenshot'], retryAllowed: true } }
  }
  const capture = new Requiring([bad.base + '/a', secondary.base + '/b', good.base + '/c'], options)
  await capture.capture()
  const pages = capture.multipage.pages
  // Rejected on the way to the target, rejected for a resource of the page, and not at all.
  assert.deepEqual(pages.map(page => [page.outcome, page.reason, page.attempts.length]), [['failed', 'tls_validation_failed', 1], ['partial', 'tls_validation_failed', 1], ['failed', 'artifact_missing', 2]])
  assert.deepEqual(pages[0].steps[0].reason, 'tls_validation_failed')
  assert.deepEqual(pages.slice(0, 2).map(page => page.attempts[0].retryAllowed), [true, true])
  assert.equal(good.hits.filter(hit => hit.method === 'GET' && hit.path === '/c').length, 2)
  assert.equal(bad.hits.length, 0)
})

test('all TLS-failed targets produce FAILED and a valid diagnostic summary', async t => {
  const bad = await fixture(t, 'untrusted')
  const capture = await Scoop.capture([bad.base + '/a', bad.base + '/b'], options)
  assert.equal(capture.state, Scoop.states.FAILED)
  assert.deepEqual(capture.multipage.pages.map(page => page.outcome), ['failed', 'failed'])
  assert.equal((await capture.summary()).errors.length, 2)
  assert.equal(bad.hits.length, 0)
})

test('older version-1 archives without diagnostics remain readable; malformed metadata is rejected', async t => {
  const origin = await fixture(t, null)
  const capture = await Scoop.capture([origin.base + '/'], options)
  const { path, zip: originalZip } = await archive(t, capture)
  let zip = originalZip
  const metadata = JSON.parse(zip.readAsText('datapackage.json'))
  metadata.extras.multipage.version = 1
  delete metadata.extras.captureErrors
  zip.updateFile('datapackage.json', Buffer.from(JSON.stringify(metadata)))
  await writeFile(path, zip.toBuffer())
  zip = new AdmZip(await readFile(path))
  const restored = await Scoop.fromWACZ(path)
  assert.equal(restored.multipage.version, 1)
  assert.deepEqual(restored.errors, [])
  metadata.extras.captureErrors = [{ kind: 'tls_validation_failed', code: 'CERT_HAS_EXPIRED', message: 'expired', phase: 'proxy', url: null, hostname: 'localhost', port: 443, pageId: 'page-9999' }]
  zip.updateFile('datapackage.json', Buffer.from(JSON.stringify(metadata)))
  await writeFile(path, zip.toBuffer())
  zip = new AdmZip(await readFile(path))
  await assert.rejects(Scoop.fromWACZ(path), /TLS diagnostics/)
  metadata.extras.multipage.pages[0].outcome = 'partial'
  metadata.extras.multipage.pages[0].reason = 'tls_validation_failed'
  metadata.extras.captureErrors = []
  zip.updateFile('datapackage.json', Buffer.from(JSON.stringify(metadata)))
  await writeFile(path, zip.toBuffer())
  zip = new AdmZip(await readFile(path))
  await assert.rejects(Scoop.fromWACZ(path), /page reason/)
})

test('HEAD preserves policy enforcement and ordinary 405 fallback with mandatory TLS', async t => {
  const origin = await fixture(t, 'valid', (request, response) => {
    if (request.method !== 'HEAD') return false
    response.writeHead(405, { 'content-type': 'application/json' }); response.end(); return true
  })
  const policy = new NetworkPolicy(['127.0.0.1'])
  try { await assert.rejects(fetchHead(origin.base + '/', policy), /Blocked/) } finally { policy.close() }
  const capture = await Scoop.capture([origin.base + '/'], options)
  assert.equal(capture.state, Scoop.states.COMPLETE)
  assert.deepEqual(capture.errors, [])
})

test('CLI saves TLS-failed JSON and exits 1; secondary loss exports and exits 0', async t => {
  const bad = await fixture(t, 'untrusted')
  const good = await fixture(t, null, (request, response) => {
    const body = html + `<img src="${bad.base}/lost.png">`
    response.writeHead(200, { 'content-type': 'text/html' }); response.end(request.method === 'HEAD' ? undefined : body); return true
  })
  const dir = await directory(t)
  const cli = fileURLToPath(new URL('../../../bin/cli.js', import.meta.url))
  for (const [url, code, state] of [[bad.base + '/', 1, Scoop.states.FAILED], [good.base + '/', 0, Scoop.states.PARTIAL]]) {
    const summary = join(dir, `summary-${code}.json`)
    const output = join(dir, `archive-${code}.wacz`)
    let actual = 0
    try {
      await exec(process.execPath, [cli, url, '--output', output, '--json-summary-output', summary,
        '--blocklist', '', '--proxy-port', '0', '--log-level', 'silent',
        '--capture-video-as-attachment', 'false', '--capture-certificates-as-attachment', 'false',
        '--provenance-summary', 'false', '--screenshot', 'false', '--dom-snapshot', 'false',
        '--auto-scroll', 'false', '--auto-play-media', 'false', '--grab-secondary-resources', 'false',
        '--run-site-specific-behaviors', 'false', '--load-timeout', '3000', '--network-idle-timeout', '600'],
      { timeout: 30000 })
    } catch (error) {
      if (error.code !== 1) throw error
      actual = error.code
    }
    assert.equal(actual, code, 'CLI must exit with its capture status')
    const data = JSON.parse(await readFile(summary, 'utf8'))
    assert.equal(data.state, state)
    assert.ok(data.errors.some(error => error.kind === 'tls_validation_failed'))
    if (code === 1) await assert.rejects(access(output))
    else await access(output)
  }
})
