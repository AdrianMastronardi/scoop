import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import net from 'node:net'
import https from 'node:https'
import { generateKeyPairSync, sign } from 'node:crypto'
import { clientDefaults } from '@harvard-lil/portal'
import express from 'express'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from './utils/exec.js'
import AdmZip from 'adm-zip'
import { chromium } from 'playwright'
import { Scoop } from './Scoop.js'
import { ScoopProxy } from './intercepters/ScoopProxy.js'

const options = {
  logLevel: 'silent',
  blocklist: [],
  proxyHost: '127.0.0.1',
  proxyPort: 0,
  screenshot: false,
  domSnapshot: true,
  captureVideoAsAttachment: false,
  captureCertificatesAsAttachment: false,
  provenanceSummary: false,
  autoScroll: false,
  autoPlayMedia: false,
  grabSecondaryResources: false,
  runSiteSpecificBehaviors: false,
  ytDlpPath: process.execPath,
  cripPath: process.execPath
}

await test('invalid locale fails before browser or proxy startup', async t => {
  const launch = t.mock.method(chromium, 'launch', () => assert.fail('browser started'))
  const proxy = t.mock.method(ScoopProxy.prototype, 'setup', () => assert.fail('proxy started'))
  for (const locale of [null, true, false, 1, [], ['es-ES'], {}, ' ', ' es', 'es ', 'not_a_locale', 'es,en', 'es;q=0.8', 'es\r\nX: y', 'es\0']) {
    assert.throws(() => new Scoop('http://127.0.0.1/', { ...options, locale }), /locale/)
    await assert.rejects(Scoop.capture('http://127.0.0.1/', { ...options, locale }), /locale/)
  }
  assert.equal(launch.mock.callCount(), 0)
  assert.equal(proxy.mock.callCount(), 0)
})

await test('setup failures retain configuration and original errors and release resources', async t => {
  for (const stage of ['context', 'page', 'launch']) {
    for (const locale of [undefined, '', 'es-es']) {
      await t.test(`${stage}, locale=${JSON.stringify(locale)}`, async t => {
        const canonical = locale ? Intl.getCanonicalLocales(locale)[0] : ''
        const original = new Error(`Simulated ${stage} rejection`)
        let contextOptions
        let closed = 0
        let contexts = 0
        let pages = 0
        const launch = t.mock.method(chromium, 'launch', async () => {
          if (stage === 'launch') throw original
          return {
            newContext: async value => {
              contexts++
              contextOptions = value
              if (stage === 'context') throw original
              return { newPage: async () => { pages++; throw original } }
            },
            close: async () => { closed++ }
          }
        })
        const errors = []
        const traces = []
        const capture = new Scoop('http://127.0.0.1/', { ...options, locale, logLevel: 'trace' })
        t.mock.method(capture.log, 'error', value => errors.push(value))
        t.mock.method(capture.log, 'trace', value => traces.push(value))
        t.mock.method(capture.log, 'info', () => {})
        await capture.capture()
        assert.equal(capture.state, Scoop.states.FAILED)
        assert.equal(launch.mock.callCount(), 1)
        assert.equal(closed, stage === 'launch' ? 0 : 1)
        assert.equal(contexts, stage === 'launch' ? 0 : 1)
        assert.equal(pages, stage === 'page' ? 1 : 0)
        if (stage !== 'launch') {
          assert.deepEqual(contextOptions, {
            ...capture.intercepter.contextOptions,
            userAgent: capture.provenanceInfo.userAgent,
            ...(canonical ? { locale: canonical } : {}),
            extraHTTPHeaders: { 'Accept-Encoding': 'gzip, compress, deflate, br' }
          })
        }
        assert(errors.some(message => message.includes(original.message)))
        assert.equal(errors.some(message => message.includes(`locale=${JSON.stringify(canonical)}`)), Boolean(canonical))
        assert(traces.includes(original))
        await assert.rejects(access(capture.captureTmpFolderPath), { code: 'ENOENT' })
        const probe = net.createServer()
        probe.listen(capture.options.proxyPort, '127.0.0.1')
        await once(probe, 'listening')
        await new Promise(resolve => probe.close(resolve))
        assert.deepEqual(capture.exchanges, [])
        const summary = await capture.summary()
        assert.equal(summary.options.locale, canonical)
        assert.deepEqual(summary.provenanceInfo, {})
        assert.equal(capture.provenanceInfo.options, undefined)
      })
    }
  }
})

async function origin (t, app) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  return `http://127.0.0.1:${server.address().port}`
}

await test('locale governs browser formatting and every content path without changing infrastructure or time zone', { timeout: 90000 }, async t => {
  const environment = { ...process.env }
  const nodeLocale = Intl.DateTimeFormat().resolvedOptions().locale
  const requests = []
  const pending = []
  const first = express()
  const second = express()
  for (const [name, app] of [['first', first], ['second', second]]) {
    app.use((req, _res, next) => {
      requests.push({ origin: name, path: req.path, method: req.method, language: req.headers['accept-language'], mode: req.headers['sec-fetch-mode'] })
      next()
    })
  }
  const signingKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  first.post('/sign', express.json(), (req, res) => res.json({
    ...req.body,
    software: 'Scoop locale test signer',
    publicKey: signingKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    signature: sign('sha256', Buffer.from(req.body.hash), signingKey.privateKey).toString('base64')
  }))
  const firstUrl = await origin(t, first)
  const secondUrl = await origin(t, second)
  function html (id) {
    return `<!doctype html><title>Locale fixture</title>
      <link rel="icon" href="${secondUrl}/favicon/${id}">
      <link rel="stylesheet" href="${firstUrl}/asset/${id}">
      <pre id="observations"></pre><script>
        document.getElementById('observations').textContent = JSON.stringify({
          language: navigator.language,
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          number: new Intl.NumberFormat().formatToParts(1234567.891),
          date: new Intl.DateTimeFormat(undefined, {
            timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
          }).formatToParts(new Date('2026-01-15T12:00:00Z'))
        })
      </script>`
  }
  first.get('/start/:id', (req, res) => res.redirect(secondUrl + '/page/' + req.params.id))
  first.get('/asset/:id', (req, res) => res.redirect(secondUrl + '/resource/' + req.params.id))
  second.get('/resource/:id', (_req, res) => res.type('css').send('body { color: black; }'))
  second.get('/favicon/:id', (_req, res) => res.type('image/x-icon').send('fixture icon'))
  first.get('/ip', (_req, res) => res.type('text').send('203.0.113.1'))
  second.get('/page/:id', (req, res) => {
    const reply = () => res.send(html(req.params.id))
    if (req.params.id.startsWith('overlap') && req.method === 'GET') {
      pending.push(reply)
      if (pending.length === 2) pending.forEach(reply => reply())
    } else reply()
  })
  first.get('/negotiate/:id', (req, res) => {
    if (req.headers['accept-language'] === 'es-ES') res.send(html(req.params.id))
    else res.type('application/octet-stream').send(Buffer.from('baseline representation'))
  })
  first.get('/download/:id', (req, res) => res.redirect(secondUrl + '/binary/' + req.params.id))
  second.get('/binary/:id', (_req, res) => res.type('application/octet-stream').send(Buffer.from('downloaded content')))

  async function run (id, overrides = {}, route = '/start/') {
    const capture = await Scoop.capture(firstUrl + route + id, {
      ...options, publicIpResolverEndpoint: firstUrl + '/ip', ...overrides
    })
    assert.equal(capture.state, Scoop.states.COMPLETE)
    const dom = capture.exchanges.find(exchange => exchange.url === 'file:///dom-snapshot.html').response.body.toString()
    const observed = JSON.parse(dom.match(/<pre id="observations">(.*?)<\/pre>/s)[1])
    const summary = await capture.summary()
    assert.equal(summary.options.locale, overrides.locale ? Intl.getCanonicalLocales(overrides.locale)[0] : '')
    if (!overrides.provenanceSummary) assert.deepEqual(summary.provenanceInfo, {})
    return { capture, observed }
  }
  const baseline = await run('baseline', { provenanceSummary: true })
  assert.equal(baseline.capture.provenanceInfo.options.locale, '')
  const [spanish, british] = await Promise.all([
    run('overlap-es', { locale: 'es-es', provenanceSummary: true }),
    run('overlap-en', { locale: 'en-GB' })
  ])
  assert.equal(pending.length, 2)
  assert.notEqual(spanish.capture.options.proxyPort, british.capture.options.proxyPort)
  const inherited = await run('inherited', { locale: undefined })
  const empty = await run('empty', { locale: '' })
  assert.deepEqual(inherited.observed, baseline.observed)
  assert.deepEqual(empty.observed, baseline.observed)
  const parts = (values, type) => values.filter(part => part.type === type).map(part => part.value)
  for (const [result, locale, group, decimal, month] of [
    [spanish, 'es-ES', '.', ',', 'enero'],
    [british, 'en-GB', ',', '.', 'January']
  ]) {
    assert.equal(result.observed.language, locale)
    assert.equal(result.observed.zone, baseline.observed.zone)
    assert.deepEqual(parts(result.observed.number, 'integer'), ['1', '234', '567'])
    assert.deepEqual(parts(result.observed.number, 'group'), [group, group])
    assert.deepEqual(parts(result.observed.number, 'decimal'), [decimal])
    assert.deepEqual(parts(result.observed.number, 'fraction'), ['891'])
    for (const [type, value] of [['year', '2026'], ['month', month], ['day', '15'], ['hour', '12'], ['minute', '00']]) {
      assert.deepEqual(parts(result.observed.date, type), [value])
    }
  }
  function contentRequests (id) {
    return requests.filter(request => request.path.endsWith('/' + id))
  }
  for (const [id, locale] of [['overlap-es', 'es-ES'], ['overlap-en', 'en-GB']]) {
    const seen = contentRequests(id)
    for (const [method, route] of [['HEAD', 'start'], ['HEAD', 'page'], ['GET', 'start'], ['GET', 'page'], ['GET', 'asset'], ['GET', 'resource'], ['GET', 'favicon']]) {
      assert(seen.some(request => request.method === method && request.path === `/${route}/${id}`), `${method} ${route} missing`)
    }
    assert(seen.every(request => request.language === locale), JSON.stringify(seen))
  }
  for (const id of ['baseline', 'inherited', 'empty']) {
    const seen = contentRequests(id)
    assert(seen.filter(request => request.method === 'HEAD').every(request => request.language === '*'))
    assert(seen.filter(request => request.path.startsWith('/favicon/')).every(request => request.language === undefined))
    assert.equal(seen.find(request => request.path.startsWith('/page/') && request.method === 'GET').language,
      contentRequests('baseline').find(request => request.path.startsWith('/page/') && request.method === 'GET').language)
  }
  const classified = await run('classified', { locale: 'es-es' }, '/negotiate/')
  assert.equal(classified.capture.targetUrlIsWebPage, true)
  for (const [id, locale] of [['binary-es', 'es-es'], ['binary-default', undefined], ['binary-empty', '']]) {
    const capture = await Scoop.capture(firstUrl + '/download/' + id, { ...options, locale })
    assert.equal(capture.state, Scoop.states.PARTIAL)
    assert.equal(capture.targetUrlIsWebPage, false)
    assert(capture.exchanges.some(exchange => exchange.response?.body?.toString() === 'downloaded content'))
    for (const request of contentRequests(id)) {
      assert.equal(request.language, locale ? 'es-ES' : request.method === 'HEAD' ? '*' : undefined)
    }
    assert.equal(contentRequests(id).length, 4)
  }
  const baselineNonHtml = await Scoop.capture(firstUrl + '/negotiate/non-html', options)
  assert.equal(baselineNonHtml.targetUrlIsWebPage, false)
  assert.equal(baselineNonHtml.state, Scoop.states.PARTIAL)
  assert(requests.filter(request => request.path === '/ip').length >= 2)
  assert(requests.filter(request => request.path === '/ip').every(request => request.language === undefined))
  assert.equal(spanish.capture.provenanceInfo.captureIp, '203.0.113.1')
  assert.equal((await spanish.capture.summary()).provenanceInfo.options.locale, 'es-ES')
  assert(spanish.capture.exchanges.some(exchange => exchange.url === 'file:///provenance-summary.html'))
  for (const [capture, locale] of [[baseline.capture, ''], [spanish.capture, 'es-ES']]) {
    const zip = new AdmZip(Buffer.from(await capture.toWACZ(false, { url: firstUrl + '/sign' })))
    assert.equal(JSON.parse(zip.readAsText('datapackage.json')).extras.provenanceInfo.options.locale, locale)
    assert(JSON.parse(zip.readAsText('datapackage-digest.json')).signedData)
  }
  const signingRequests = requests.filter(request => request.path === '/sign')
  assert.equal(signingRequests.length, 2)
  assert.equal(signingRequests[1].language, signingRequests[0].language)
  assert.notEqual(signingRequests[1].language, 'es-ES')

  // Exercise the real CLI through the same live content paths and archive export.
  const directory = await mkdtemp(join(tmpdir(), 'scoop-locale-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await exec(process.execPath, [
    fileURLToPath(new URL('./bin/cli.js', import.meta.url)), firstUrl + '/start/cli',
    '--locale', 'es-es', '--blocklist', '', '--proxy-port', '0', '--log-level', 'silent',
    '--screenshot', 'false', '--dom-snapshot', 'true',
    '--auto-scroll', 'false', '--auto-play-media', 'false',
    '--grab-secondary-resources', 'false', '--run-site-specific-behaviors', 'false',
    '--capture-video-as-attachment', 'false', '--capture-certificates-as-attachment', 'false',
    '--public-ip-resolver-endpoint', firstUrl + '/ip',
    '--output', join(directory, 'capture.wacz'), '--json-summary-output', join(directory, 'summary.json')
  ], { timeout: 20000 })
  assert(contentRequests('cli').length >= 7)
  assert(contentRequests('cli').every(request => request.language === 'es-ES'))
  const cliSummary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))
  assert.equal(cliSummary.state, Scoop.states.COMPLETE)
  assert.equal(cliSummary.options.locale, 'es-ES')
  assert.equal(cliSummary.provenanceInfo.options.locale, 'es-ES')
  assert.deepEqual({ ...process.env }, environment)
  assert.equal(Intl.DateTimeFormat().resolvedOptions().locale, nodeLocale)
})

await test('locale does not add language arguments to certificate collection or its health check', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'scoop-locale-certs-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const argsFile = join(directory, 'args.jsonl')
  const crip = join(directory, 'crip.mjs')
  await writeFile(crip, `#!/usr/bin/env node
    import { appendFileSync } from 'node:fs'
    appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n')
    console.log(${JSON.stringify(clientDefaults.cert)})
  `, { mode: 0o755 })
  const server = https.createServer(clientDefaults, (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><title>Certificates</title><link rel="icon" href="data:,">')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `https://127.0.0.1:${server.address().port}/`
  for (const locale of [undefined, 'es-es']) {
    const capture = await Scoop.capture(url, { ...options, locale, cripPath: crip, captureCertificatesAsAttachment: true })
    assert.equal(capture.state, Scoop.states.COMPLETE)
    assert.equal(capture.steps.find(step => step.name === 'Capturing certificates info').outcome, 'completed')
    assert.equal(capture.provenanceInfo.certificates.length, 1)
  }
  const calls = (await readFile(argsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.length, 4)
  assert.deepEqual(calls[0], [])
  assert.deepEqual(calls[2], [])
  for (const call of [calls[1], calls[3]]) {
    assert.deepEqual(call.slice(0, 8), ['print', '-u', new URL(url).origin, '-f', 'pem', '--proxy-host', '127.0.0.1', '--proxy-port'])
    assert.equal(call.length, 9)
    assert(Number(call[8]) > 0)
  }
})
