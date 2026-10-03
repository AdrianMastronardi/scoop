import test from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { once } from 'node:events'
import net from 'node:net'
import express from 'express'
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

await test('invalid timezoneId fails before browser or proxy startup', async t => {
  const launch = t.mock.method(chromium, 'launch', () => assert.fail('browser started'))
  const proxy = t.mock.method(ScoopProxy.prototype, 'setup', () => assert.fail('proxy started'))
  for (const timezoneId of [null, true, false, 1, [], ['UTC'], {}, ' ', ' UTC', 'UTC ', 'Mars/Olympus', '+01:00', '-05:00']) {
    assert.throws(() => new Scoop('http://127.0.0.1/', { ...options, timezoneId }), /timezoneId/)
    await assert.rejects(Scoop.capture('http://127.0.0.1/', { ...options, timezoneId }), /timezoneId/)
  }
  assert.equal(launch.mock.callCount(), 0)
  assert.equal(proxy.mock.callCount(), 0)
})

await test('setup failures retain configuration and original errors and release resources', async t => {
  for (const stage of ['context', 'page', 'launch']) {
    for (const timezoneId of [undefined, '', 'US/Eastern']) {
      await t.test(`${stage}, timezoneId=${JSON.stringify(timezoneId)}`, async t => {
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
        const capture = new Scoop('http://127.0.0.1/', { ...options, timezoneId, logLevel: 'trace' })
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
            ...(timezoneId ? { timezoneId } : {}),
            extraHTTPHeaders: { 'Accept-Encoding': 'gzip, compress, deflate, br' }
          })
        }
        assert(errors.some(message => message.includes(original.message)))
        assert.equal(errors.some(message => message.includes(`timezoneId=${JSON.stringify(timezoneId)}`)), Boolean(timezoneId))
        assert(traces.includes(original))
        await assert.rejects(access(capture.captureTmpFolderPath), { code: 'ENOENT' })
        const probe = net.createServer()
        probe.listen(capture.options.proxyPort, '127.0.0.1')
        await once(probe, 'listening')
        await new Promise(resolve => probe.close(resolve))
        assert.deepEqual(capture.exchanges, [])
        const summary = await capture.summary()
        assert.equal(summary.options.timezoneId, timezoneId ?? '')
        assert.deepEqual(summary.provenanceInfo, {})
        assert.equal(capture.provenanceInfo.options, undefined)
      })
    }
  }
})

await test('browser time zones are isolated and preserve instants, language and provenance', { timeout: 90000 }, async t => {
  const environment = { ...process.env }
  const nodeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const app = express()
  const pending = []
  const html = requestLanguage => `<!doctype html><title>Time zone fixture</title><link rel="icon" href="data:,"><pre id="observations"></pre><script>
    const dates = ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z'].map(value => {
      const date = new Date(value)
      return { epoch: date.getTime(), iso: date.toISOString(), offset: date.getTimezoneOffset(), hour: date.getHours(), minute: date.getMinutes() }
    })
    document.getElementById('observations').textContent = JSON.stringify({
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      requestLanguage: ${JSON.stringify(requestLanguage)},
      dates
    })
  </script>`
  app.get('/ip', (_req, res) => res.type('text').send('203.0.113.1'))
  app.get(['/fixture', '/overlap'], (req, res) => {
    if (req.path === '/overlap' && req.method === 'GET') {
      pending.push(() => res.send(html(req.headers['accept-language'] ?? null)))
      if (pending.length === 2) pending.forEach(reply => reply())
    } else {
      res.send(html(req.headers['accept-language'] ?? null))
    }
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  async function run (overrides = {}, route = '/fixture') {
    const capture = await Scoop.capture(baseUrl + route, {
      ...options,
      publicIpResolverEndpoint: baseUrl + '/ip',
      ...overrides
    })
    assert.equal(capture.state, Scoop.states.COMPLETE)
    const dom = capture.exchanges.find(exchange => exchange.url === 'file:///dom-snapshot.html').response.body.toString()
    const observed = JSON.parse(dom.match(/<pre id="observations">(.*?)<\/pre>/s)[1])
    const summary = await capture.summary()
    assert.equal(summary.options.timezoneId, overrides.timezoneId ?? '')
    if (!overrides.provenanceSummary) assert.deepEqual(summary.provenanceInfo, {})
    return { capture, observed }
  }
  const baseline = await run()
  const [madrid, utc] = await Promise.all([
    run({ timezoneId: 'Europe/Madrid' }, '/overlap'),
    run({ timezoneId: 'UTC' }, '/overlap')
  ])
  assert.equal(pending.length, 2)
  assert.notEqual(madrid.capture.options.proxyPort, utc.capture.options.proxyPort)
  const kathmandu = await run({ timezoneId: 'Asia/Kathmandu' })
  const eastern = await run({ timezoneId: 'US/Eastern', provenanceSummary: true })
  const inherited = await run({ timezoneId: undefined })
  const empty = await run({ timezoneId: '' })
  assert.deepEqual(inherited.observed, baseline.observed)
  assert.deepEqual(empty.observed, baseline.observed)
  assert.equal(madrid.observed.zone, 'Europe/Madrid')
  assert.equal(utc.observed.zone, 'UTC')
  for (const [result, offsets, hours, minute] of [
    [madrid, [-60, -120], [13, 14], 0],
    [utc, [0, 0], [12, 12], 0],
    [kathmandu, [-345, -345], [17, 17], 45],
    [eastern, [300, 240], [7, 8], 0]
  ]) {
    assert.equal(result.observed.language, baseline.observed.language)
    assert.equal(result.observed.requestLanguage, baseline.observed.requestLanguage)
    assert.deepEqual(result.observed.dates.map(date => date.offset), offsets)
    assert.deepEqual(result.observed.dates.map(date => date.hour), hours)
    assert.deepEqual(result.observed.dates.map(date => date.minute), [minute, minute])
    assert.deepEqual(result.observed.dates.map(({ epoch, iso }) => ({ epoch, iso })), [
      { epoch: Date.parse('2026-01-15T12:00:00Z'), iso: '2026-01-15T12:00:00.000Z' },
      { epoch: Date.parse('2026-07-15T12:00:00Z'), iso: '2026-07-15T12:00:00.000Z' }
    ])
  }
  assert.equal(eastern.capture.provenanceInfo.captureIp, '203.0.113.1')
  assert.equal((await eastern.capture.summary()).provenanceInfo.options.timezoneId, 'US/Eastern')
  assert(eastern.capture.exchanges.some(exchange => exchange.url === 'file:///provenance-summary.html'))
  const zip = new AdmZip(Buffer.from(await eastern.capture.toWACZ()))
  const metadata = JSON.parse(zip.readAsText('datapackage.json'))
  assert.equal(metadata.extras.provenanceInfo.options.timezoneId, 'US/Eastern')
  assert.deepEqual({ ...process.env }, environment)
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, nodeZone)
})
