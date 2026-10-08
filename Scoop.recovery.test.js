import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, errors } from 'playwright'
import AdmZip from 'adm-zip'
import { WARCParser } from 'warcio'
import { Scoop } from './Scoop.js'
import { FIXTURES_PATH } from './constants.js'

const options = {
  logLevel: 'silent',
  blocklist: [],
  proxyPort: 0,
  chromiumSandbox: true,
  screenshot: true,
  domSnapshot: false,
  pdfSnapshot: false,
  captureVideoAsAttachment: false,
  captureCertificatesAsAttachment: false,
  provenanceSummary: false,
  autoScroll: false,
  autoPlayMedia: false,
  grabSecondaryResources: false,
  runSiteSpecificBehaviors: false,
  captureTimeout: 30000,
  loadTimeout: 3000,
  networkIdleTimeout: 1000
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** A local site. `handle` may answer a request itself; `hits` lists the GET requests for pages. */
async function fixture (t, handle) {
  const hits = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (req.method === 'GET') hits.push(url.pathname)
    if (handle?.(req, res, url, hits)) return
    if (url.pathname === '/resource') {
      const body = Buffer.alloc(32768, 65)
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length })
      res.end(body); return
    }
    const body = `<!doctype html><title>${url.pathname}</title><link rel="icon" href="data:,"><p>${url.pathname}</p>`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.closeAllConnections(); server.close() })
  return { base: `http://127.0.0.1:${server.address().port}`, hits }
}

/** Calls `configure(page, index, browser)` for each page the capture opens, counted from 1. */
function configurePages (t, configure) {
  const launch = chromium.launch.bind(chromium)
  const browsers = []
  let contexts = 0
  const pages = []
  t.mock.method(chromium, 'launch', async options => {
    const browser = await launch(options)
    browsers.push(browser)
    const newContext = browser.newContext.bind(browser)
    t.mock.method(browser, 'newContext', async options => {
      contexts++
      const context = await newContext(options)
      context.on('page', page => { pages.push(page); configure(page, pages.length, browser) })
      return context
    })
    return browser
  })
  return { pages, counts: () => [browsers.length, contexts] }
}

/**
 * A capture that requires artifacts of every visit, as a consumer would: by the bytes it was
 * given when they were generated, not by a name in the inventory.
 */
class Requiring extends Scoop {
  required = ['screenshot']
  assessed = []
  generated = []

  addGeneratedExchange (url, headers, body, isEntryPoint, description, run) {
    const added = super.addGeneratedExchange(url, headers, body, isEntryPoint, description, run)
    if (added && run?.id) {
      const exchange = this.exchanges.at(-1)
      this.generated.push({ url: exchange.url, pageId: exchange.pageId, attemptNumber: exchange.attemptNumber, run: run.attemptNumber })
    }
    return added
  }

  async assessPageAttempt (attempt, signal) {
    this.assessed.push(attempt)
    const body = name => this.exchanges.find(exchange => exchange.url === `file:///${name}`)?.response.body
    const valid = {
      screenshot: () => body(attempt.attachments.screenshot)?.subarray(0, 8).equals(PNG),
      domSnapshot: () => body(attempt.attachments.domSnapshot)?.length > 0
    }
    return { missingArtifacts: this.required.filter(artifact => !valid[artifact]()), retryAllowed: true }
  }
}

async function capture (Class, urls, extra = {}) {
  const instance = new Class(urls, { ...options, ...extra })
  await instance.capture()
  return instance
}

async function archive (t, instance, raw = true) {
  const directory = await mkdtemp(join(tmpdir(), 'scoop-recovery-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'capture.wacz')
  await writeFile(path, Buffer.from(await instance.toWACZ(raw)))
  return { path, directory, zip: new AdmZip(path) }
}

const failingScreenshot = error => page => { page.screenshot = async () => { throw error() } }

test('without failures every page gets one visit, and no assessment is asked for more', { timeout: 30000 }, async t => {
  const { base, hits } = await fixture(t)
  configurePages(t, (page, index) => { if (index === 2) failingScreenshot(() => new Error('fixture screenshot failure'))(page) })
  const instance = await Scoop.capture([base + '/a', base + '/b'], { ...options, provenanceSummary: true, publicIpResolverEndpoint: base + '/ip' })
  const { multipage } = instance

  assert.equal(instance.state, Scoop.states.COMPLETE)
  assert.equal(multipage.version, 3)
  assert.deepEqual(hits.filter(path => ['/a', '/b'].includes(path)), ['/a', '/b'])
  for (const page of multipage.pages) {
    assert.equal(page.retryCount, 0)
    assert.equal(page.attempts.length, 1)
    const [attempt] = page.attempts
    assert.deepEqual({ pageId: attempt.pageId, attemptNumber: attempt.attemptNumber, requestedUrl: attempt.requestedUrl }, { pageId: page.id, attemptNumber: 1, requestedUrl: page.requestedUrl })
    for (const field of ['resolvedUrl', 'startedAt', 'finishedAt', 'outcome', 'reason', 'httpStatus', 'contentType', 'pageInfo', 'entryPoint', 'attachments', 'steps']) assert.deepEqual(page[field], attempt[field], field)
    assert.ok(attempt.exchangeIds.length > 0)
    assert.ok(attempt.steps.every(step => step.pageId === page.id && step.attemptNumber === 1))
    // The method Scoop comes with requires nothing: its answer is recorded, and nothing follows.
    assert.deepEqual([attempt.missingArtifacts, attempt.retryAllowed], [[], false])
    assert.equal(page.outcome, 'complete')
  }
  // A failed screenshot is a failed step of a complete page, as before: nobody required it.
  assert.equal(multipage.pages[0].attachments.screenshot, 'page-0001-screenshot.png')
  assert.equal(multipage.pages[1].attachments.screenshot, undefined)
  assert.deepEqual(multipage.pages[1].steps.find(step => step.name === 'Screenshot'), { ...multipage.pages[1].steps.find(step => step.name === 'Screenshot'), outcome: 'failed', reason: 'artifact_generation_failed' })

  assert.deepEqual(multipage.globalSteps.map(step => [step.name, step.pageId, step.attemptNumber]), [['Provenance summary', null, null]])
  assert.deepEqual(instance.steps, [...multipage.pages.flatMap(page => page.steps), ...multipage.globalSteps])
  assert.deepEqual(instance.steps.map(step => step.id), instance.steps.map((_, index) => `step-${String(index + 1).padStart(4, '0')}`))
  assert.deepEqual(instance.provenanceInfo.multipage, multipage)
  for (const step of instance.steps) {
    if (step.outcome === 'completed') assert.equal(step.reason, null)
    if (step.outcome === 'failed') assert.equal(typeof step.reason, 'string')
  }
})

test('a screenshot that fails on the first visit is recovered by the second, and both are kept', { timeout: 60000 }, async t => {
  const { base, hits } = await fixture(t)
  let during
  let assessing
  const observed = configurePages(t, (page, index) => {
    if (index === 1) failingScreenshot(() => new Error('fixture screenshot failure'))(page)
    if (index === 2) page.once('request', () => { during ||= instance.multipage.pages[0] })
  })
  class Observing extends Requiring {
    async assessPageAttempt (attempt, signal) {
      assessing ||= this.multipage.pages[0]
      return await super.assessPageAttempt(attempt, signal)
    }
  }
  const instance = new Observing([base + '/a', base + '/b'], { ...options, domSnapshot: true })
  await instance.capture()
  const { multipage } = instance
  const [first, second] = multipage.pages[0].attempts

  assert.equal(instance.state, Scoop.states.COMPLETE)
  assert.deepEqual(multipage.pages.map(page => [page.outcome, page.reason, page.retryCount, page.attempts.length]), [['complete', null, 1, 2], ['complete', null, 0, 1]])
  // Both visits start from the requested URL, and the second is of that page alone.
  assert.deepEqual(hits.filter(path => ['/a', '/b'].includes(path)), ['/a', '/a', '/b'])
  assert.deepEqual(observed.counts(), [1, 1])
  assert.ok(observed.pages.every(page => page.isClosed()))

  // The first visit: its failure, what it was assessed as, and the evidence it did leave.
  assert.deepEqual([first.outcome, first.reason, first.missingArtifacts, first.retryAllowed], ['failed', 'artifact_missing', ['screenshot'], true])
  assert.deepEqual(first.steps.filter(step => step.outcome === 'failed').map(step => [step.name, step.reason, step.attemptNumber]), [['Screenshot', 'artifact_generation_failed', 1]])
  assert.deepEqual(first.attachments, { domSnapshot: 'page-0001-dom-snapshot.html' })
  assert.equal(first.entryPoint.url, base + '/a')
  // The second: complete, with artifacts of its own under names of their own.
  assert.deepEqual([second.outcome, second.reason, second.missingArtifacts, second.retryAllowed], ['complete', null, [], true])
  assert.deepEqual(second.attachments, { screenshot: 'page-0001-attempt-2-screenshot.png', domSnapshot: 'page-0001-attempt-2-dom-snapshot.html' })
  assert.deepEqual(multipage.pages[0].attachments, second.attachments)
  assert.deepEqual(multipage.pages[0].steps, second.steps)
  assert.ok(Date.parse(second.startedAt) >= Date.parse(first.finishedAt))
  assert.ok(second.steps.every(step => step.attemptNumber === 2 && step.outcome === 'completed'))
  assert.deepEqual(multipage.pages[1].attachments, { screenshot: 'page-0002-screenshot.png', domSnapshot: 'page-0002-dom-snapshot.html' })

  // Each visit has its own exchanges, by identity.
  const ids = new Set(instance.exchanges.map(exchange => exchange.id))
  assert.ok(first.exchangeIds.length > 0 && second.exchangeIds.length > 0)
  assert.ok([...first.exchangeIds, ...second.exchangeIds].every(id => ids.has(id)))
  assert.equal(new Set([...first.exchangeIds, ...second.exchangeIds, ...multipage.pages[1].attempts[0].exchangeIds]).size, first.exchangeIds.length + second.exchangeIds.length + multipage.pages[1].attempts[0].exchangeIds.length)
  const visited = attempt => instance.exchanges.filter(exchange => attempt.exchangeIds.includes(exchange.id)).map(exchange => exchange.url)
  assert.ok(visited(first).includes(base + '/a') && visited(second).includes(base + '/a'))

  // Who generated what is known when it is generated, and stays on the exchange.
  assert.deepEqual(instance.generated.filter(artifact => artifact.pageId === 'page-0001'), [
    { url: 'file:///page-0001-dom-snapshot.html', pageId: 'page-0001', attemptNumber: 1, run: 1 },
    { url: 'file:///page-0001-attempt-2-screenshot.png', pageId: 'page-0001', attemptNumber: 2, run: 2 },
    { url: 'file:///page-0001-attempt-2-dom-snapshot.html', pageId: 'page-0001', attemptNumber: 2, run: 2 }
  ])
  // What was assessed is a copy of each visit as it ended, before its assessment.
  assert.deepEqual(instance.assessed.map(attempt => [attempt.pageId, attempt.attemptNumber, attempt.outcome, 'retryAllowed' in attempt]), [['page-0001', 1, 'complete', false], ['page-0001', 2, 'complete', false], ['page-0002', 1, 'complete', false]])

  // The trace has both visits, in order.
  assert.deepEqual(instance.steps, [...first.steps, ...second.steps, ...multipage.pages[1].steps])
  assert.deepEqual(instance.steps.map(step => step.id), instance.steps.map((_, index) => `step-${String(index + 1).padStart(4, '0')}`))

  // While it was captured: the page stays the active one through its assessment and second visit.
  assert.deepEqual([assessing.outcome, assessing.finishedAt, assessing.retryCount, assessing.attempts.length], ['capturing', null, 0, 1])
  assert.ok(assessing.attempts[0].finishedAt)
  assert.deepEqual([during.outcome, during.finishedAt, during.retryCount, during.attempts.length], ['capturing', null, 1, 2])
  assert.deepEqual([during.attempts[0].outcome, during.attempts[1].outcome, during.attempts[1].finishedAt], ['failed', 'capturing', null])

  // Exported and read back: the same history, exchanges, artifacts and attribution.
  const { path, zip } = await archive(t, instance)
  const datapackage = JSON.parse(zip.readAsText('datapackage.json'))
  assert.deepEqual(datapackage.extras.multipage, multipage)
  const pages = zip.readAsText('pages/pages.jsonl').trim().split('\n').slice(1).map(line => JSON.parse(line))
  assert.deepEqual(pages.filter(page => page.url.startsWith('http')).map(page => [page.url, page.ts]), [[base + '/a', second.entryPoint.ts], [base + '/b', multipage.pages[1].entryPoint.ts]])
  assert.notEqual(first.entryPoint.ts, second.entryPoint.ts)
  const records = []
  for await (const record of new WARCParser([zip.readFile('archive/data.warc.gz')])) {
    records.push({ type: record.warcType, url: record.warcTargetURI, page: record.warcHeader('Scoop-Page-ID'), attempt: record.warcHeader('Scoop-Attempt-Number'), exchange: record.warcHeader('Scoop-Exchange-ID'), body: Buffer.from(await record.readFully(false)) })
  }
  assert.deepEqual(records.filter(record => record.page === 'page-0001').map(record => [record.url, record.attempt]), [
    ['file:///page-0001-dom-snapshot.html', '1'],
    ['file:///page-0001-attempt-2-screenshot.png', '2'],
    ['file:///page-0001-attempt-2-dom-snapshot.html', '2']
  ])
  for (const attempt of [first, second]) {
    const response = records.find(record => record.type === 'response' && record.url === base + '/a' && attempt.exchangeIds.includes(record.exchange))
    assert.ok(response.body.includes('<p>/a</p>'))
  }

  const restored = await Scoop.fromWACZ(path)
  assert.equal(restored.state, Scoop.states.RECONSTRUCTED)
  assert.deepEqual(restored.multipage, multipage)
  assert.deepEqual(restored.steps, instance.steps)
  for (const exchange of instance.exchanges.filter(exchange => exchange.pageId)) {
    const copy = restored.exchanges.find(copy => copy.url === exchange.url)
    assert.deepEqual([copy.pageId, copy.sourceUrl, copy.attemptNumber], [exchange.pageId, exchange.sourceUrl, exchange.attemptNumber])
    assert.ok(copy.response.body.equals(exchange.response.body))
  }
  for (const exchange of instance.exchanges.filter(exchange => exchange.requestRaw)) {
    const copy = restored.exchanges.find(copy => copy.id === exchange.id)
    assert.deepEqual(copy.requestRaw, exchange.requestRaw)
    assert.deepEqual(copy.responseRaw, exchange.responseRaw)
  }
  // Exporting again, and without raw exchanges, changes nothing of it.
  const again = []
  for await (const record of new WARCParser([await restored.toWARC()])) again.push([record.warcTargetURI, record.warcHeader('Scoop-Attempt-Number')])
  assert.deepEqual(again.filter(([url]) => url?.startsWith('file:///page-0001')), records.filter(record => record.page === 'page-0001').map(record => [record.url, record.attempt]))
  const { zip: plain } = await archive(t, instance, false)
  assert.deepEqual(JSON.parse(plain.readAsText('datapackage.json')).extras.multipage, multipage)
  assert.ok(!plain.getEntries().some(entry => entry.entryName.startsWith('raw/')))
})

test('a screenshot that fails twice ends its page with artifact_missing after two visits, and the list goes on', { timeout: 60000 }, async t => {
  const { base, hits } = await fixture(t)
  // Every screenshot fails but that of the third page opened: the one visit to the second URL.
  configurePages(t, (page, index) => { if (index !== 3) failingScreenshot(() => new Error('fixture screenshot failure'))(page) })
  const instance = await capture(Requiring, [base + '/a', base + '/b'])
  const { multipage } = instance

  assert.equal(instance.state, Scoop.states.PARTIAL)
  assert.deepEqual(hits.filter(path => ['/a', '/b'].includes(path)), ['/a', '/a', '/b'])
  assert.deepEqual(multipage.pages.map(page => [page.outcome, page.reason, page.retryCount, page.attempts.length]), [['failed', 'artifact_missing', 1, 2], ['complete', null, 0, 1]])
  assert.deepEqual(multipage.pages[0].attempts.map(attempt => [attempt.outcome, attempt.reason, attempt.missingArtifacts, attempt.retryAllowed]), [['failed', 'artifact_missing', ['screenshot'], true], ['failed', 'artifact_missing', ['screenshot'], true]])
  assert.equal(instance.assessed.length, 3)
  // What the visits did record is kept, and exported.
  assert.ok(multipage.pages[0].attempts.every(attempt => attempt.entryPoint && attempt.exchangeIds.length))
  const restored = await Scoop.fromWACZ((await archive(t, instance)).path)
  assert.deepEqual(restored.multipage, multipage)

  // A page that fails this way was visited, twice: on its own it still makes a capture worth exporting.
  const alone = await capture(Requiring, [base + '/alone'])
  assert.equal(alone.state, Scoop.states.PARTIAL)
  assert.deepEqual(alone.multipage.pages.map(page => [page.outcome, page.reason, page.attempts.length]), [['failed', 'artifact_missing', 2]])
  assert.deepEqual((await Scoop.fromWACZ((await archive(t, alone)).path)).multipage, alone.multipage)
})

test('invalid bytes count as a missing artifact, and an optional one that is absent does not', { timeout: 60000 }, async t => {
  const { base, hits } = await fixture(t)
  configurePages(t, (page, index) => {
    if (index === 1) {
      // Bytes that Scoop itself can tell are not a screenshot, and a DOM that only its consumer finds wanting.
      page.screenshot = async () => Buffer.from('not a PNG')
      page.content = async () => ''
    }
    page.pdf = async () => { throw new Error('fixture PDF failure') }
  })
  class RequiringDOM extends Requiring { required = ['screenshot', 'domSnapshot'] }
  const instance = await capture(RequiringDOM, [base + '/a'], { domSnapshot: true, pdfSnapshot: true })
  const [first, second] = instance.multipage.pages[0].attempts

  assert.deepEqual(hits.filter(path => path === '/a'), ['/a', '/a'])
  assert.deepEqual(first.steps.filter(step => step.outcome === 'failed').map(step => [step.name, step.reason]), [['Screenshot', 'artifact_invalid'], ['PDF snapshot', 'artifact_generation_failed']])
  // The first visit did produce a DOM snapshot: what is wrong with its bytes is the consumer's to say.
  assert.deepEqual(first.attachments, { domSnapshot: 'page-0001-dom-snapshot.html' })
  assert.equal(instance.exchanges.find(exchange => exchange.url === 'file:///page-0001-dom-snapshot.html').response.body.length, 0)
  assert.deepEqual([first.outcome, first.reason, first.missingArtifacts], ['failed', 'artifact_missing', ['screenshot', 'domSnapshot']])
  assert.deepEqual([second.outcome, second.reason, second.missingArtifacts], ['complete', null, []])
  // No PDF either time, which nobody required: a failed step, and no third visit.
  assert.ok([first, second].every(attempt => !attempt.attachments.pdfSnapshot && attempt.steps.some(step => step.name === 'PDF snapshot' && step.outcome === 'failed' && step.reason === 'artifact_generation_failed')))
  assert.equal(instance.state, Scoop.states.COMPLETE)
})

test('an ordinary DOM snapshot failure leaves its page usable and is recovered by a second visit', { timeout: 60000 }, async t => {
  const { base } = await fixture(t)
  configurePages(t, (page, index) => { if (index === 1) page.content = async () => { throw new Error('fixture DOM failure') } })
  class RequiringDOM extends Requiring { required = ['screenshot', 'domSnapshot'] }
  const instance = await capture(RequiringDOM, [base + '/a'], { domSnapshot: true })
  const [first, second] = instance.multipage.pages[0].attempts

  assert.deepEqual([first.outcome, first.reason, first.missingArtifacts], ['failed', 'artifact_missing', ['domSnapshot']])
  assert.deepEqual(first.steps.filter(step => step.outcome !== 'completed').map(step => [step.name, step.outcome, step.reason]), [['DOM snapshot', 'failed', 'artifact_generation_failed']])
  assert.equal(first.attachments.screenshot, 'page-0001-screenshot.png')
  assert.deepEqual([second.outcome, second.attachments.domSnapshot], ['complete', 'page-0001-attempt-2-dom-snapshot.html'])
  assert.equal(instance.state, Scoop.states.COMPLETE)
})

test('a DOM snapshot past its deadline fails that page alone: no second visit, and the next page is captured', { timeout: 60000 }, async t => {
  const { base, hits } = await fixture(t)
  let late
  const observed = configurePages(t, (page, index) => {
    // Never answers within the deadline; answers once its visit is long over.
    if (index === 2) page.content = () => new Promise(resolve => { late = () => resolve('<p>late DOM</p>') })
  })
  class RequiringDOM extends Requiring {
    required = ['screenshot', 'domSnapshot']
    async assessPageAttempt (attempt, signal) {
      if (attempt.pageId === 'page-0003') late()
      return await super.assessPageAttempt(attempt, signal)
    }
  }
  const instance = await capture(RequiringDOM, [base + '/a', base + '/b', base + '/c'], { domSnapshot: true, pdfSnapshot: true })
  const { multipage } = instance
  const [timedOut] = multipage.pages[1].attempts

  assert.equal(instance.state, Scoop.states.PARTIAL)
  assert.deepEqual(multipage.pages.map(page => [page.outcome, page.reason, page.attempts.length]), [['complete', null, 1], ['failed', 'snapshot_timeout', 1], ['complete', null, 1]])
  assert.deepEqual(hits.filter(path => ['/a', '/b', '/c'].includes(path)), ['/a', '/b', '/c'])
  // The consumer did say the DOM was missing, and would have allowed a visit: the deadline rules it out.
  assert.deepEqual([timedOut.missingArtifacts, timedOut.retryAllowed], [['domSnapshot'], true])
  assert.deepEqual(timedOut.steps.filter(step => step.outcome !== 'completed').map(step => [step.name, step.outcome, step.reason]), [['DOM snapshot', 'failed', 'snapshot_timeout'], ['PDF snapshot', 'skipped', 'snapshot_timeout']])
  const snapshot = timedOut.steps.find(step => step.name === 'DOM snapshot')
  assert.ok(snapshot.durationMs >= 10000 && snapshot.durationMs < 16000)
  // What the visit had before its deadline is kept; what answered late is nobody's evidence.
  assert.equal(timedOut.attachments.screenshot, 'page-0002-screenshot.png')
  assert.ok(timedOut.entryPoint && timedOut.exchangeIds.length)
  assert.ok(!instance.exchanges.some(exchange => exchange.response?.body?.includes?.('late DOM')))
  assert.deepEqual(multipage.pages[2].attachments, { screenshot: 'page-0003-screenshot.png', domSnapshot: 'page-0003-dom-snapshot.html', pdfSnapshot: 'page-0003-pdf-snapshot.pdf' })
  // One browser and one context throughout, and no page left behind.
  assert.deepEqual(observed.counts(), [1, 1])
  assert.equal(observed.pages.length, 3)
  assert.ok(observed.pages.every(page => page.isClosed()))
  assert.deepEqual((await Scoop.fromWACZ((await archive(t, instance)).path)).multipage, multipage)
})

test('a page that will not close after its deadline, or a lost browser, ends the session with their causes', { timeout: 90000 }, async t => {
  const { base, hits } = await fixture(t)
  configurePages(t, (page, index) => {
    if (index !== 2) return
    page.content = () => new Promise(() => {})
    page.close = () => new Promise(() => {})
  })
  const stuck = await Scoop.capture([base + '/a', base + '/b', base + '/c'], { ...options, domSnapshot: true })
  assert.equal(stuck.state, Scoop.states.PARTIAL)
  assert.deepEqual(stuck.multipage.pages.map(page => [page.outcome, page.reason, page.attempts.length]), [['complete', null, 1], ['failed', 'snapshot_timeout', 1], ['skipped', 'session_failed', 0]])
  assert.ok(!hits.includes('/c'))
  assert.deepEqual((await Scoop.fromWACZ((await archive(t, stuck)).path)).multipage, stuck.multipage)

  t.mock.restoreAll()
  configurePages(t, (page, index, browser) => {
    if (index === 2) page.waitForLoadState = async () => { await browser.close(); throw new Error('fixture browser loss') }
  })
  const lost = await capture(Requiring, [base + '/d', base + '/e', base + '/f'])
  assert.equal(lost.state, Scoop.states.PARTIAL)
  assert.deepEqual(lost.multipage.pages.map(page => [page.outcome, page.attempts.length]), [['complete', 1], ['failed', 1], ['skipped', 0]])
  assert.equal(lost.multipage.pages[2].reason, 'session_failed')
  assert.deepEqual(lost.multipage.pages[1].steps.filter(step => step.outcome === 'failed').map(step => [step.name, step.reason]), [['Wait for network idle', 'browser_disconnected']])
  // The visit that lost its browser is not assessed, let alone repeated.
  assert.deepEqual(lost.assessed.map(attempt => attempt.pageId), ['page-0001'])
  assert.ok(!hits.includes('/f'))
})

test('a typed timeout and an early exception of the screenshot get different reasons, and no text of either is exported', { timeout: 30000 }, async t => {
  const { base } = await fixture(t)
  configurePages(t, (page, index) => {
    failingScreenshot(() => index === 1 ? new errors.TimeoutError('page.screenshot: Timeout 5000ms exceeded. SECRET-TIMEOUT-TEXT') : new Error('SECRET-EXCEPTION-TEXT'))(page)
  })
  const instance = await Scoop.capture([base + '/a', base + '/b'], options)
  const reasons = instance.multipage.pages.map(page => page.steps.find(step => step.name === 'Screenshot')).map(step => [step.outcome, step.reason])

  assert.deepEqual(reasons, [['failed', 'step_timeout'], ['failed', 'artifact_generation_failed']])
  // Neither took anywhere near five seconds: the reason is not a guess from the duration.
  assert.ok(instance.multipage.pages.every(page => page.steps.find(step => step.name === 'Screenshot').durationMs < 1000))
  const exported = JSON.stringify([instance.multipage, await instance.summary()])
  assert.ok(!exported.includes('SECRET'))
  assert.ok(!(await archive(t, instance)).zip.readAsText('datapackage.json').includes('SECRET'))
})

test('HTTP errors and a refused destination are not grounds for a second visit, whatever the assessment says', { timeout: 60000 }, async t => {
  const statuses = { '/403': 403, '/404': 404, '/429': 429, '/500': 500, '/503': 503 }
  const { base, hits } = await fixture(t, (req, res, url) => {
    if (url.pathname === '/blocked-redirect') { res.writeHead(302, { location: '/private', 'content-length': '0' }); res.end(); return true }
    if (!statuses[url.pathname]) return false
    const body = `<!doctype html><title>${url.pathname}</title><p>error</p>`
    res.writeHead(statuses[url.pathname], { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body), ...(url.pathname === '/503' ? { 'retry-after': '120' } : {}) })
    res.end(body); return true
  })
  // Nothing takes a screenshot here: every visit lacks the one that is required.
  const urls = [...Object.keys(statuses), '/blocked-redirect', '/ok'].map(path => base + path)
  const instance = await capture(Requiring, urls, { screenshot: false, blocklist: ['/private/'], captureTimeout: 50000 })
  const { multipage } = instance

  for (const [index, status] of Object.values(statuses).entries()) {
    const page = multipage.pages[index]
    assert.deepEqual([page.attempts.length, page.retryCount, page.httpStatus, page.outcome, page.reason], [1, 0, status, 'complete', null], page.requestedUrl)
    assert.deepEqual([page.attempts[0].missingArtifacts, page.attempts[0].retryAllowed], [['screenshot'], true])
  }
  const refused = multipage.pages[5]
  assert.deepEqual([refused.attempts.length, refused.outcome, refused.entryPoint], [1, 'complete', null])
  // Refused twice: to the request that looks at what the URL leads to, then to the browser.
  assert.deepEqual(refused.steps.filter(step => step.outcome === 'failed').map(step => [step.name, step.reason]), [['Out-of-browser detection and capture of non-web resource', 'network_policy_blocked'], ['Wait for initial page load', 'network_policy_blocked']])
  assert.ok(!hits.includes('/private'))
  // With nothing else against it, the same assessment does get its page a second visit.
  assert.deepEqual([multipage.pages[6].attempts.length, multipage.pages[6].reason], [2, 'artifact_missing'])
  assert.deepEqual(hits.filter(path => path !== '/favicon.ico'), ['/403', '/404', '/429', '/500', '/503', '/blocked-redirect', '/ok', '/ok'])

  // A consumer's own veto: missing artifacts are recorded, and the visit keeps what Scoop observed.
  class Vetoing extends Requiring {
    async assessPageAttempt (attempt, signal) { return { ...await super.assessPageAttempt(attempt, signal), retryAllowed: false } }
  }
  const vetoed = await capture(Vetoing, [base + '/vetoed'], { screenshot: false })
  assert.deepEqual(vetoed.multipage.pages[0].attempts.map(attempt => [attempt.outcome, attempt.reason, attempt.missingArtifacts, attempt.retryAllowed]), [['complete', null, ['screenshot'], false]])
  assert.equal(vetoed.state, Scoop.states.COMPLETE)
})

test('a stop between or during visits is never followed by another, and both visits spend the one budget', { timeout: 60000 }, async t => {
  const page = '<!doctype html><title>budget</title><link rel="icon" href="data:,"><script>fetch("/resource")</script>'
  const { base, hits } = await fixture(t, (req, res, url) => {
    if (!['/a', '/b', '/c', '/d'].includes(url.pathname)) return false
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(page) })
    res.end(page); return true
  })
  configurePages(t, page => failingScreenshot(() => new Error('fixture screenshot failure'))(page))

  // The size budget holds one visit and not two: the second stops on what the first spent.
  const sized = await capture(Requiring, [base + '/a', base + '/b'], { maxCaptureSize: 50000 })
  assert.equal(sized.state, Scoop.states.PARTIAL)
  assert.deepEqual(sized.multipage.pages.map(page => [page.outcome, page.reason, page.retryCount, page.attempts.length]), [['partial', 'capture_size_limit', 1, 2], ['skipped', 'capture_size_limit', 0, 0]])
  assert.deepEqual(sized.multipage.pages[0].attempts.map(attempt => [attempt.outcome, attempt.reason]), [['failed', 'artifact_missing'], ['partial', 'capture_size_limit']])
  assert.ok(sized.intercepter.byteLength >= 50000)
  // The second visit was stopped, not assessed: nothing of the first stands in for it.
  assert.ok(!('retryAllowed' in sized.multipage.pages[0].attempts[1]))
  assert.deepEqual(hits.filter(path => ['/a', '/b'].includes(path)), ['/a', '/a'])

  // A stop while the first visit is assessed: its decision comes too late to be one.
  let signalled
  class Stopping extends Requiring {
    async assessPageAttempt (attempt, signal) {
      signalled = signal
      this.stopRecording('capture_timeout')
      return await super.assessPageAttempt(attempt, signal)
    }
  }
  const stopped = await capture(Stopping, [base + '/c', base + '/d'])
  assert.equal(stopped.state, Scoop.states.PARTIAL)
  assert.equal(signalled.aborted, true)
  assert.deepEqual(stopped.multipage.pages.map(page => [page.outcome, page.reason, page.retryCount, page.attempts.length]), [['partial', 'capture_timeout', 0, 1], ['skipped', 'capture_timeout', 0, 0]])
  assert.ok(!('retryAllowed' in stopped.multipage.pages[0].attempts[0]))
  assert.deepEqual(hits.filter(path => ['/c', '/d'].includes(path)), ['/c'])
})

test('an assessment that throws, answers something else or never answers gets no visit and no success', { timeout: 60000 }, async t => {
  const { base, hits } = await fixture(t)
  const failures = {
    throws: async () => { throw new Error('fixture assessment failure') },
    nothing: async () => undefined,
    unknown: async () => ({ missingArtifacts: ['favicon'], retryAllowed: true }),
    repeated: async () => ({ missingArtifacts: ['screenshot', 'screenshot'], retryAllowed: true }),
    truthy: async () => ({ missingArtifacts: [], retryAllowed: 'yes' })
  }
  for (const [name, assess] of Object.entries(failures)) {
    class Failing extends Scoop { assessPageAttempt = assess }
    const instance = await capture(Failing, [`${base}/${name}/a`, `${base}/${name}/b`])
    assert.equal(instance.state, Scoop.states.FAILED, name)
    assert.deepEqual(instance.multipage.pages.map(page => [page.outcome, page.reason, page.attempts.length]), [['failed', 'session_failed', 1], ['skipped', 'session_failed', 0]], name)
    assert.ok(!('retryAllowed' in instance.multipage.pages[0].attempts[0]), name)
    // What the visit captured is still there to be read.
    assert.ok(instance.multipage.pages[0].attachments.screenshot, name)
    assert.deepEqual(hits.filter(path => path.startsWith(`/${name}/`)), [`/${name}/a`], name)
  }

  let signalled
  class Pending extends Scoop {
    assessPageAttempt (attempt, signal) { signalled = signal; return new Promise(() => {}) }
  }
  const pending = await capture(Pending, [base + '/pending/a', base + '/pending/b'], { captureTimeout: 4000 })
  assert.equal(pending.state, Scoop.states.PARTIAL)
  assert.equal(signalled.aborted, true)
  assert.deepEqual(pending.multipage.pages.map(page => [page.outcome, page.reason, page.attempts.length]), [['partial', 'capture_timeout', 1], ['skipped', 'capture_timeout', 0]])
  assert.deepEqual(hits.filter(path => path.startsWith('/pending/')), ['/pending/a'])
})

test('the page entry is its second visit when that one differs: status, resolved URL and entry point', { timeout: 60000 }, async t => {
  const { base } = await fixture(t, (req, res, url, hits) => {
    if (req.method !== 'GET') return false
    const visits = hits.filter(path => path === url.pathname).length
    if (url.pathname === '/moves' && visits === 2) { res.writeHead(302, { location: '/moved', 'content-length': '0' }); res.end(); return true }
    if (url.pathname === '/breaks' && visits === 2) {
      const body = '<!doctype html><title>gone</title><p>gone</p>'
      res.writeHead(500, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) }); res.end(body); return true
    }
    return false
  })
  configurePages(t, (page, index) => { if (index === 1 || index === 3) failingScreenshot(() => new Error('fixture screenshot failure'))(page) })
  const instance = await capture(Requiring, [base + '/moves', base + '/breaks'])
  const [moves, breaks] = instance.multipage.pages

  assert.deepEqual(moves.attempts.map(attempt => [attempt.resolvedUrl, attempt.httpStatus, attempt.outcome]), [[base + '/moves', 200, 'failed'], [base + '/moved', 200, 'complete']])
  assert.deepEqual([moves.resolvedUrl, moves.outcome, moves.entryPoint], [base + '/moved', 'complete', moves.attempts[1].entryPoint])
  assert.notEqual(moves.entryPoint.ts, moves.attempts[0].entryPoint.ts)
  // The second visit met an error that the first had not: that is what the page ends with.
  assert.deepEqual(breaks.attempts.map(attempt => [attempt.httpStatus, attempt.outcome, attempt.reason]), [[200, 'failed', 'artifact_missing'], [500, 'complete', null]])
  assert.deepEqual([breaks.httpStatus, breaks.outcome, breaks.retryCount], [500, 'complete', 1])
  assert.deepEqual((await Scoop.fromWACZ((await archive(t, instance)).path)).multipage, instance.multipage)
})

test('reconstruction rejects histories that do not hold together, and accepts what the page repeats of its last visit', { timeout: 60000 }, async t => {
  const { base } = await fixture(t)
  configurePages(t, (page, index) => { if (index === 1) failingScreenshot(() => new Error('fixture screenshot failure'))(page) })
  const instance = await capture(Requiring, [base + '/a', base + '/b'], { domSnapshot: true })
  const { path, directory } = await archive(t, instance)
  const bytes = await readFile(path)
  // As exported, the page and its last visit name the same artifacts and steps.
  assert.deepEqual((await Scoop.fromWACZ(path)).multipage.pages[0].attachments, instance.multipage.pages[0].attempts[1].attachments)

  const same = (page, change) => { change(page.attempts.at(-1)); Object.assign(page, Object.fromEntries(['outcome', 'reason', 'steps', 'attachments', 'startedAt', 'finishedAt'].map(field => [field, page.attempts.at(-1)[field]]))) }
  const mutations = {
    'a third visit': ['visit count', data => { data.pages[0].attempts.push({ ...data.pages[0].attempts[1], attemptNumber: 3 }) }],
    'a count that is not the visits made': ['visit count', data => { data.pages[0].retryCount = 0 }],
    'a revisit that was not counted': ['visit count', data => { data.pages[1].retryCount = 1 }],
    'visits out of order': ['visit identity/order', data => { data.pages[0].attempts.reverse() }],
    'a visit before the previous one ended': ['visit interval', data => { data.pages[0].attempts[0].finishedAt = data.pages[0].attempts[1].finishedAt }],
    'a step recorded twice': ['step identity/ownership', data => same(data.pages[0], attempt => { attempt.steps[1].id = attempt.steps[0].id })],
    'a step of another visit': ['step identity/ownership', data => same(data.pages[0], attempt => { attempt.steps[0].attemptNumber = 1 })],
    'a step of another page': ['step identity/ownership', data => { data.pages[0].attempts[0].steps[0].pageId = 'page-0002' }],
    'a step outside its visit': ['step interval', data => { data.pages[0].attempts[0].steps[0].startedAt = data.pages[0].attempts[1].finishedAt }],
    'a failed step without a reason': ['step reason', data => { data.pages[0].attempts[0].steps.find(step => step.outcome === 'failed').reason = null }],
    'a reason in free text': ['step reason', data => { data.pages[0].attempts[0].steps.find(step => step.outcome === 'failed').reason = 'page.screenshot: Timeout 5000ms exceeded' }],
    'a completed step with a reason': ['step reason', data => same(data.pages[1], attempt => { attempt.steps[0].reason = 'step_failed' })],
    'an unknown page reason': ['visit reason', data => { data.pages[0].attempts[0].reason = 'unlucky' }],
    'artifact_missing without its assessment': ['visit assessment', data => { delete data.pages[0].attempts[0].missingArtifacts; delete data.pages[0].attempts[0].retryAllowed }],
    'artifact_missing that was not allowed': ['visit assessment', data => { data.pages[0].attempts[0].retryAllowed = false }],
    'an unknown required artifact': ['visit assessment', data => { data.pages[0].attempts[0].missingArtifacts = ['favicon'] }],
    'half an assessment': ['visit assessment', data => { delete data.pages[1].attempts[0].retryAllowed }],
    'a revisit after an HTTP error': ['revisit after an excluded outcome', data => { data.pages[0].attempts[0].httpStatus = 503 }],
    'a revisit after a complete visit': ['revisit after an excluded outcome', data => { Object.assign(data.pages[0].attempts[0], { outcome: 'complete', reason: null, missingArtifacts: [] }) }],
    'a visit still under way': ['nonterminal outcome', data => same(data.pages[1], attempt => { attempt.outcome = 'capturing' })],
    'a visit that pretends not to have started': ['skipped page data', data => same(data.pages[1], attempt => { attempt.outcome = 'skipped'; attempt.reason = 'session_failed' })],
    'a visit without its exchanges': ['missing visit fields', data => { delete data.pages[1].attempts[0].exchangeIds }],
    'an exchange of two visits': ['missing/conflicting exchange reference', data => { data.pages[0].attempts[1].exchangeIds.push(data.pages[0].attempts[0].exchangeIds[0]) }],
    'an exchange of another page': ['missing/conflicting exchange reference', data => { data.pages[1].attempts[0].exchangeIds.push(data.pages[0].attempts[1].exchangeIds[0]) }],
    'an exchange that is not there': ['missing/conflicting exchange reference', data => { data.pages[1].attempts[0].exchangeIds.push('00000000-0000-4000-8000-000000000000') }],
    'an artifact of the other visit': ['missing/conflicting artifact', data => { data.pages[0].attempts[0].attachments.screenshot = 'page-0001-attempt-2-screenshot.png' }],
    'an artifact of another page': ['unsafe/conflicting artifact reference', data => same(data.pages[1], attempt => { attempt.attachments.screenshot = 'page-0001-attempt-2-screenshot.png' })],
    'an artifact that is not there': ['missing/conflicting artifact', data => { data.pages[0].attempts[0].attachments.screenshot = 'page-0001-screenshot.png' }],
    'an artifact nobody references': ['unreferenced page artifact', data => { delete data.pages[0].attempts[0].attachments.domSnapshot }],
    'a page that is not its last visit': ['page projection', data => { data.pages[0].attachments = data.pages[0].attempts[0].attachments }],
    'a page with the outcome of its first visit': ['page projection', data => { data.pages[0].outcome = 'failed'; data.pages[0].reason = 'artifact_missing' }],
    'no global steps': ['global steps', data => { delete data.globalSteps }],
    'a global step of a page': ['step identity/ownership', data => { data.globalSteps.push({ ...data.pages[1].attempts[0].steps[0], id: 'step-9999' }) }]
  }
  for (const [name, [rule, mutate]] of Object.entries(mutations)) {
    const copy = new AdmZip(bytes)
    const manifest = JSON.parse(copy.readAsText('datapackage.json'))
    mutate(manifest.extras.multipage)
    copy.updateFile('datapackage.json', Buffer.from(JSON.stringify(manifest)))
    const mutated = join(directory, 'mutated.wacz')
    await writeFile(mutated, copy.toBuffer())
    await assert.rejects(Scoop.fromWACZ(mutated), { message: `Invalid multipage inventory: ${rule}` }, name)
  }
})

test('archives with inventory versions 1 and 2 are read by their own rules, and gain nothing they did not record', async t => {
  for (const version of [1, 2]) {
    const path = `${FIXTURES_PATH}multipage-v${version}.wacz`
    const restored = await Scoop.fromWACZ(path)
    const recorded = JSON.parse(new AdmZip(path).readAsText('datapackage.json')).extras.multipage
    const { multipage } = restored

    assert.equal(multipage.version, version)
    assert.deepEqual(multipage, recorded)
    assert.deepEqual(multipage.pages.map(page => [page.outcome, 'attempts' in page, 'retryCount' in page]), [['complete', false, false], ['complete', false, false]])
    assert.ok(!('globalSteps' in multipage))
    // A failed step had no reason then, and is given none now.
    assert.deepEqual(multipage.pages[0].steps.filter(step => step.outcome === 'failed').map(step => [step.name, step.reason, 'attemptNumber' in step]), [['Screenshot', null, false]])
    assert.deepEqual(restored.steps, multipage.pages.flatMap(page => page.steps))
    assert.ok(restored.exchanges.filter(exchange => exchange.pageId).every(exchange => exchange.attemptNumber === undefined))
    const urls = []
    for await (const record of new WARCParser([await restored.toWARC()])) urls.push([record.warcTargetURI, record.warcHeader('Scoop-Page-ID'), record.warcHeader('Scoop-Attempt-Number')])
    assert.ok(urls.some(([url, page, attempt]) => url === 'file:///page-0002-screenshot.png' && page === 'page-0002' && attempt === null))

    // Their rules are theirs: what version 3 requires of a failed step they still refuse.
    const directory = await mkdtemp(join(tmpdir(), 'scoop-recovery-legacy-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    for (const mutate of [data => { data.pages[0].steps.find(step => step.outcome === 'failed').reason = 'artifact_generation_failed' }, data => { data.pages[0].reason = 'artifact_missing'; data.pages[0].outcome = 'failed' }]) {
      const zip = new AdmZip(await readFile(path))
      const manifest = JSON.parse(zip.readAsText('datapackage.json'))
      mutate(manifest.extras.multipage)
      zip.updateFile('datapackage.json', Buffer.from(JSON.stringify(manifest)))
      await writeFile(join(directory, 'mutated.wacz'), zip.toBuffer())
      await assert.rejects(Scoop.fromWACZ(join(directory, 'mutated.wacz')), /step reason|page reason/)
    }
  }
})

test('a URL given as a string is captured as before: one visit, no assessment, steps without reasons', { timeout: 30000 }, async t => {
  const { base, hits } = await fixture(t)
  configurePages(t, page => failingScreenshot(() => new errors.TimeoutError('fixture timeout'))(page))
  const instance = await capture(Requiring, base + '/a', { domSnapshot: true })

  assert.equal(instance.state, Scoop.states.COMPLETE)
  assert.equal(instance.multipage, undefined)
  assert.deepEqual(instance.assessed, [])
  assert.deepEqual(hits.filter(path => path === '/a'), ['/a'])
  assert.deepEqual(instance.steps.find(step => step.name === 'Screenshot'), { name: 'Screenshot', startedAt: instance.steps.find(step => step.name === 'Screenshot').startedAt, outcome: 'failed', durationMs: instance.steps.find(step => step.name === 'Screenshot').durationMs })
  assert.ok(instance.steps.every(step => !('reason' in step) && !('attemptNumber' in step) && !('id' in step)))
  const summary = await instance.summary()
  assert.deepEqual(summary.attachments, { domSnapshot: 'dom-snapshot.html' })
  assert.ok(instance.exchanges.filter(exchange => exchange.url.startsWith('file:///')).every(exchange => exchange.attemptNumber === undefined && exchange.pageId === undefined))
})
