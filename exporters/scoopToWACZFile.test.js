import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'

import AdmZip from 'adm-zip'

import { Scoop } from '../Scoop.js'
import * as CONSTANTS from '../constants.js'
import * as exporters from './index.js'
import { scoopToWACZFile } from './scoopToWACZ.js'
import { rawResourceName } from './rawResourceName.js'
import { usesStoreCompression } from '../utils/zip.js'
import { parseCDXJ, parseWARC, readWARC } from '../utils/fixtures/export/archive.mjs'
import { MiB, attachment, proxyExchange, sha256, syntheticCapture } from '../utils/fixtures/export/capture.mjs'

const FAIL_FIXTURE = join(CONSTANTS.BASE_PATH, 'utils', 'fixtures', 'export', 'fail.mjs')

async function workspace (t) {
  const directory = await mkdtemp(join(tmpdir(), 'scoop-wacz-file-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function exchanges () {
  return [
    proxyExchange('https://fixture.example/', 2.5 * MiB, { seed: 1, type: 'text/html' }),
    proxyExchange('https://fixture.example/form?step=1', 300, { seed: 2, method: 'POST', requestBody: 'name=value&other=1', requestType: 'application/x-www-form-urlencoded', date: new Date('2026-10-03T10:00:03.000Z') }),
    proxyExchange('https://fixture.example/empty', 0, { seed: 3, date: new Date('2026-10-03T10:00:04.000Z') }),
    attachment('screenshot.png', 70000, { seed: 4, type: 'image/png', description: 'Capture Time Screenshot', isEntryPoint: true }),
    attachment('provenance-summary.html', 900, { seed: 5, type: 'text/html', description: 'Provenance Summary', isEntryPoint: true }),
    attachment('video-extracted-1.mp4', 40000, { seed: 6, type: 'video/mp4' })
  ]
}

/** The entries of a WACZ by name, after checking it is a ZIP that only stores. */
async function readWACZ (path) {
  const bytes = await readFile(path)
  assert.ok(usesStoreCompression(bytes))
  return Object.fromEntries(new AdmZip(bytes).getEntries().map(entry => [entry.entryName, entry.getData()]))
}

/** A signing server that answers as authsign does, or with `status` when given one. */
async function signer (t, status = 200) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const { hash, created } = JSON.parse(body)
    requests.push({ hash, created, authorization: req.headers.authorization, observed: await server.observe?.() })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hash, created, software: 'local test', publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signature: sign('sha256', Buffer.from(hash), privateKey).toString('base64') }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  return { server, requests, publicKey, url: `http://127.0.0.1:${server.address().port}/sign` }
}

/** Every file under a directory, relative to it. */
async function tree (directory) {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .sort()
}

/** The worker threads started while `run` was pending. */
async function watchingWorkers (run) {
  const workers = []
  const listener = worker => workers.push(worker)
  process.on('worker', listener)
  try {
    return { result: await run().then(value => ({ value }), error => ({ error })), workers }
  } finally {
    process.off('worker', listener)
  }
}

/** What this process holds open under a directory, where the system can tell. */
async function openFilesUnder (directory) {
  if (process.platform !== 'linux') {
    return []
  }

  const targets = await Promise.all((await readdir('/proc/self/fd')).map(descriptor => readlink(`/proc/self/fd/${descriptor}`).catch(() => '')))
  return targets.filter(target => target.startsWith(directory))
}

for (const includeRaw of [false, true]) {
  test(`scoopToWACZFile writes the archive, indexes, pages, digests and attachments (includeRaw: ${includeRaw}).`, async (t) => {
    const directory = await workspace(t)
    const path = join(directory, 'capture.wacz')
    const capture = syntheticCapture(exchanges(), { state: Scoop.states.PARTIAL })
    t.mock.method(capture, 'toWARC', () => assert.fail('must not export the WARC to memory'))
    t.mock.method(capture, 'toWACZ', () => assert.fail('must not export the WACZ to memory'))

    assert.equal(await scoopToWACZFile(capture, path, includeRaw), undefined)

    const entries = await readWACZ(path)
    const names = Object.keys(entries)
    const proxied = capture.exchanges.filter(exchange => exchange.requestRaw)
    const expectedRaw = proxied.flatMap(exchange => ['request', 'response'].map(type => rawResourceName(type, exchange.date, exchange.id)))
    assert.deepEqual(names.filter(name => !name.startsWith('raw/')).sort(), ['archive/data.warc.gz', 'datapackage-digest.json', 'datapackage.json', 'indexes/index.cdx', 'pages/pages.jsonl'])
    assert.deepEqual(names.filter(name => name.startsWith('raw/')).sort(), includeRaw ? expectedRaw.sort() : [])

    // Every resource is listed with the size and digest of what the ZIP holds.
    const datapackage = JSON.parse(entries['datapackage.json'])
    assert.deepEqual(datapackage.resources.map(resource => resource.path).sort(), names.filter(name => !name.startsWith('datapackage')).sort())
    for (const resource of datapackage.resources) {
      assert.equal(resource.hash, sha256(entries[resource.path]), resource.path)
      assert.equal(resource.bytes, entries[resource.path].length, resource.path)
    }
    assert.deepEqual(JSON.parse(entries['datapackage-digest.json']), { path: 'datapackage.json', hash: sha256(entries['datapackage.json']) })
    assert.equal(datapackage.wacz_version, CONSTANTS.WACZ_VERSION)
    assert.equal(datapackage.mainPageUrl, capture.url)
    assert.equal(datapackage.mainPageDate, capture.startedAt.toISOString())
    assert.equal(datapackage.extras.state, Scoop.states.PARTIAL)
    assert.deepEqual(datapackage.extras.states, Object.keys(Scoop.states))
    assert.deepEqual(datapackage.extras.captureErrors, capture.errors)
    assert.deepEqual(datapackage.extras.provenanceInfo, JSON.parse(JSON.stringify(capture.provenanceInfo)))

    // The archive holds every exchange, attachments included.
    const warc = entries['archive/data.warc.gz']
    const records = readWARC(warc, true)
    const responses = records.filter(record => record.type === 'response')
    assert.deepEqual(responses.map(record => record.warc.get('warc-target-uri')), capture.exchanges.map(exchange => exchange.url))
    for (const [index, exchange] of capture.exchanges.entries()) {
      assert.ok(responses[index].payload.equals(exchange.response.body), exchange.url)
    }

    // Each index entry leads, by its offset and length, to the record it describes.
    const index = parseCDXJ(entries['indexes/index.cdx'].toString())
    assert.deepEqual(index.map(entry => entry.url).sort(), capture.exchanges.map(exchange => exchange.url).sort())
    assert.deepEqual(index.map(entry => `${entry.urlkey} ${entry.timestamp}`), index.map(entry => `${entry.urlkey} ${entry.timestamp}`).sort())
    for (const entry of index) {
      const [record, ...others] = parseWARC(gunzipSync(warc.subarray(Number(entry.offset), Number(entry.offset) + Number(entry.length))))
      assert.equal(others.length, 0)
      assert.equal(record.type, 'response')
      assert.equal(record.warc.get('warc-target-uri'), entry.url)
      assert.equal(record.warc.get('warc-payload-digest'), `sha256:${entry.digest}`)
      assert.equal(entry.filename, 'data.warc.gz')
    }
    assert.equal(index.find(entry => entry.method === 'POST').requestBody, 'name=value&other=1')

    // Pages: the first exchange, then the attachments that are entry points.
    const [header, ...pages] = entries['pages/pages.jsonl'].toString().trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(header, { format: 'json-pages-1.0', id: 'pages', title: 'All Pages' })
    assert.deepEqual(
      pages.map(({ url, title, ts }) => ({ url, title, ts })).sort((a, b) => a.url.localeCompare(b.url)),
      [
        { url: 'file:///provenance-summary.html', title: 'Provenance Summary', ts: capture.exchanges[4].date.toISOString() },
        { url: 'file:///screenshot.png', title: 'Capture Time Screenshot', ts: capture.exchanges[3].date.toISOString() },
        { url: 'https://fixture.example/', title: 'High-Fidelity Web Capture of https://fixture.example/', ts: capture.exchanges[0].date.toISOString() }
      ]
    )

    if (includeRaw) {
      for (const exchange of proxied) {
        assert.ok(entries[rawResourceName('request', exchange.date, exchange.id)].equals(exchange.requestRaw))
        assert.ok(entries[rawResourceName('response', exchange.date, exchange.id)].equals(exchange.responseRaw))
      }
    }

    assert.deepEqual(await readdir(directory), ['capture.wacz'])
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600)
    }
  })
}

test('toWACZFile and toWACZ describe a capture alike, and keep their own defaults for raw exchanges.', async (t) => {
  const directory = await workspace(t)
  const capture = syntheticCapture(exchanges())
  assert.equal(exporters.scoopToWACZFile, scoopToWACZFile)

  await capture.toWACZFile(join(directory, 'method.wacz'))
  await scoopToWACZFile(capture, join(directory, 'function.wacz'))
  const written = await readWACZ(join(directory, 'method.wacz'))
  const returned = Object.fromEntries(new AdmZip(Buffer.from(await capture.toWACZ())).getEntries().map(entry => [entry.entryName, entry.getData()]))

  assert.ok(Object.keys(written).some(name => name.startsWith('raw/')))
  assert.ok(!Object.keys(await readWACZ(join(directory, 'function.wacz'))).some(name => name.startsWith('raw/')))
  assert.deepEqual(Object.keys(written).sort(), Object.keys(returned).sort())

  // Alike but for what each export draws anew: record identifiers, the
  // warcinfo date, page identifiers and the creation date.
  const described = entries => {
    const { created, resources, ...datapackage } = JSON.parse(entries['datapackage.json'])
    return {
      datapackage,
      resources: resources.map(({ name, path, bytes }) => ({ name, path, bytes })).sort((a, b) => a.path.localeCompare(b.path)),
      raw: Object.keys(entries).filter(name => name.startsWith('raw/')).sort().map(name => sha256(entries[name])),
      index: parseCDXJ(entries['indexes/index.cdx'].toString()).map(({ offset, length, ...entry }) => entry),
      pages: entries['pages/pages.jsonl'].toString().trim().split('\n').map(line => JSON.parse(line)).map(({ id, ...page }) => page),
      records: readWARC(entries['archive/data.warc.gz'], true).map(record => ({
        type: record.type,
        warc: record.warc.fields.filter(([name]) => name !== 'warc-record-id' && !(record.type === 'warcinfo' && name === 'warc-date')),
        block: sha256(record.block)
      }))
    }
  }
  const [a, b] = [described(written), described(returned)]
  // Compressed sizes follow from the identifiers drawn anew: compare what is not compressed.
  const stable = resources => resources.filter(resource => !['archive/data.warc.gz', 'indexes/index.cdx', 'pages/pages.jsonl'].includes(resource.path))
  assert.deepEqual({ ...a, resources: stable(a.resources) }, { ...b, resources: stable(b.resources) })
})

test('scoopToWACZFile rejects an invalid capture or path before writing anything.', async (t) => {
  const directory = await workspace(t)
  const capture = syntheticCapture(exchanges())
  t.mock.method(capture, 'toWARCFile', () => assert.fail('must not export'))

  for (const invalid of [{}, true, null, 'FOO', syntheticCapture([], { state: Scoop.states.FAILED }), syntheticCapture(exchanges(), { state: Scoop.states.RECONSTRUCTED })]) {
    await assert.rejects(scoopToWACZFile(invalid, join(directory, 'capture.wacz')), /`capture` must be a partial or complete Scoop object/)
  }

  for (const invalid of ['', undefined, null, 12, Buffer.from('capture.wacz'), ['capture.wacz']]) {
    await assert.rejects(capture.toWACZFile(invalid), { name: 'TypeError', message: '"path" must be a non-empty string.' })
  }

  await assert.rejects(capture.toWACZFile(join(directory, 'missing', 'capture.wacz')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(directory), [])
})

test('scoopToWACZFile leaves an existing destination as it is, and lets one of two exports publish.', async (t) => {
  const directory = await workspace(t)
  const existing = join(directory, 'existing.wacz')
  const linked = join(directory, 'linked.wacz')
  await writeFile(existing, 'kept')
  await symlink(existing, linked)

  for (const path of [existing, linked]) {
    const capture = syntheticCapture(exchanges())
    t.mock.method(capture, 'toWARCFile', () => assert.fail('must not export'))
    await assert.rejects(capture.toWACZFile(path), { code: 'EEXIST' })
  }
  assert.equal(await readFile(existing, 'utf8'), 'kept')

  const path = join(directory, 'capture.wacz')
  const captures = [syntheticCapture(exchanges()), syntheticCapture(exchanges())]
  const outcomes = await Promise.allSettled(captures.map(capture => capture.toWACZFile(path, false)))
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'EEXIST')

  // Whole, and the work of one export only.
  const winner = captures[outcomes.findIndex(outcome => outcome.status === 'fulfilled')]
  const entries = await readWACZ(path)
  const ids = readWARC(entries['archive/data.warc.gz'], true).filter(record => record.type === 'response').map(record => record.warc.get('scoop-exchange-id'))
  assert.deepEqual(ids, winner.exchanges.map(exchange => exchange.id))
  assert.equal(JSON.parse(entries['datapackage-digest.json']).hash, sha256(entries['datapackage.json']))
  assert.deepEqual((await readdir(directory)).sort(), ['capture.wacz', 'existing.wacz', 'linked.wacz'])
})

test('scoopToWACZFile signs the datapackage it publishes through a signing server.', async (t) => {
  const directory = await workspace(t)
  const { requests, publicKey, url } = await signer(t)
  const capture = syntheticCapture(exchanges())

  await capture.toWACZFile(join(directory, 'signed.wacz'), false, { url, token: 'fixture-token' })
  await capture.toWACZFile(join(directory, 'unsigned.wacz'), false)

  const entries = await readWACZ(join(directory, 'signed.wacz'))
  const digest = JSON.parse(entries['datapackage-digest.json'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].authorization, 'fixture-token')
  assert.equal(requests[0].hash, sha256(entries['datapackage.json']))
  assert.equal(requests[0].created, JSON.parse(entries['datapackage.json']).created)
  assert.equal(digest.hash, requests[0].hash)
  assert.ok(verify('sha256', Buffer.from(digest.hash), publicKey, Buffer.from(digest.signedData.signature, 'base64')))
  assert.ok(!('signedData' in JSON.parse((await readWACZ(join(directory, 'unsigned.wacz')))['datapackage-digest.json'])))
})

test('scoopToWACZFile indexes with one worker, however many processors there are.', async (t) => {
  const directory = await workspace(t)
  const { result, workers } = await watchingWorkers(() => syntheticCapture(exchanges()).toWACZFile(join(directory, 'capture.wacz')))

  t.diagnostic(`availableParallelism: ${availableParallelism()}`)
  assert.equal(result.error, undefined)
  assert.equal(workers.length, 1)
  assert.equal(workers[0].threadId, -1) // It has exited by the time the export resolves.
})

test('Intermediate files stay beside the destination, whatever the temporary directories are.', async (t) => {
  const directory = await workspace(t)
  const elsewhere = await workspace(t)
  const { server, requests, url } = await signer(t)

  const previous = process.env.TMPDIR
  process.env.TMPDIR = elsewhere
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous })
  assert.equal(tmpdir(), elsewhere)

  // What is on disk once the WARC is written, then while the WACZ is being built.
  const observe = async () => ({ beside: await tree(directory), elsewhere: await tree(elsewhere) })
  let afterWARC
  class Observed extends Scoop {
    async toWARCFile (path, gzip) {
      await super.toWARCFile(path, gzip)
      afterWARC = { path, device: (await stat(path)).dev, ...await observe() }
    }
  }
  server.observe = observe

  const capture = syntheticCapture(exchanges(), { Class: Observed })
  await capture.toWACZFile(join(directory, 'capture.wacz'), true, { url })

  const device = (await stat(directory)).dev
  const [staging, ...others] = afterWARC.beside.map(file => file.split('/')[0]).filter((name, index, all) => all.indexOf(name) === index)
  assert.deepEqual(others, [])
  assert.match(staging, /^\.scoop-export-/)
  assert.equal(dirname(afterWARC.path), join(directory, staging))
  assert.equal(afterWARC.device, device)
  assert.deepEqual(afterWARC.beside, [`${staging}/data.warc.gz`])

  const whileBuilding = requests[0].observed
  assert.ok(whileBuilding.beside.every(file => file.startsWith(`${staging}/`)))
  assert.ok(whileBuilding.beside.includes(`${staging}/data.warc.gz`))
  assert.ok(whileBuilding.beside.some(file => /^\.scoop-export-[^/]+\/\.js-wacz-[^/]+\/archive\.wacz$/.test(file)))

  assert.ok(!afterWARC.path.startsWith(CONSTANTS.TMP_PATH))
  assert.deepEqual(afterWARC.elsewhere, [])
  assert.deepEqual(whileBuilding.elsewhere, [])
  assert.deepEqual(await readdir(directory), ['capture.wacz'])
  assert.deepEqual(await readdir(elsewhere), [])
})

test('A subclass can keep the complete WARC, which outlives a later failure along with its other files.', async (t) => {
  const directory = await workspace(t)
  const recovery = join(directory, 'recovery')
  await mkdir(recovery)
  await writeFile(join(directory, 'screenshot.png'), 'exported earlier')
  const { requests, url } = await signer(t, 500)

  class Recoverable extends Scoop {
    async toWARCFile (path, gzip) {
      await super.toWARCFile(path, gzip)
      // Closed and complete by now: a link on the same filesystem, or a copy.
      await link(path, join(recovery, 'linked.warc.gz'))
      await pipeline(createReadStream(path), createWriteStream(join(recovery, 'copied.warc.gz'), { flags: 'wx' }))
    }
  }
  const capture = syntheticCapture(exchanges(), { Class: Recoverable })

  const { result, workers } = await watchingWorkers(() => capture.toWACZFile(join(directory, 'capture.wacz'), true, { url }))

  assert.match(result.error.message, /An error occurred while processing WACZ file/)
  assert.ok(result.error.cause instanceof Error)
  assert.equal(requests.length, 1)
  assert.ok(workers.length === 1 && workers[0].threadId === -1)
  assert.deepEqual(await openFilesUnder(directory), [])

  // Nothing published and nothing left of the export, but for what the subclass kept.
  assert.deepEqual((await tree(directory)), ['recovery/copied.warc.gz', 'recovery/linked.warc.gz', 'screenshot.png'])
  assert.equal(await readFile(join(directory, 'screenshot.png'), 'utf8'), 'exported earlier')
  for (const name of ['linked.warc.gz', 'copied.warc.gz']) {
    const responses = readWARC(await readFile(join(recovery, name)), true).filter(record => record.type === 'response')
    assert.deepEqual(responses.map(record => record.warc.get('scoop-exchange-id')), capture.exchanges.map(exchange => exchange.id))
    assert.ok(responses.every((record, index) => record.payload.equals(capture.exchanges[index].response.body)))
  }
  assert.equal((await stat(join(recovery, 'linked.warc.gz'))).nlink, 1)
})

test('If keeping the WARC fails, the WACZ is neither indexed nor signed.', async (t) => {
  const directory = await workspace(t)
  const { requests, url } = await signer(t)
  const failure = Object.assign(new Error('fixture recovery failure'), { code: 'EFIXTURE' })

  class Unrecoverable extends Scoop {
    async toWARCFile (path, gzip) {
      await super.toWARCFile(path, gzip)
      throw failure
    }
  }

  const { result, workers } = await watchingWorkers(() =>
    syntheticCapture(exchanges(), { Class: Unrecoverable }).toWACZFile(join(directory, 'capture.wacz'), true, { url }))

  assert.match(result.error.message, /An error occurred while creating underlying WARC file \(fixture recovery failure\)/)
  assert.equal(result.error.cause, failure)
  assert.equal(result.error.code, 'EFIXTURE')
  assert.equal(workers.length, 0)
  assert.equal(requests.length, 0)
  assert.deepEqual(await readdir(directory), [])
})

test('A failure to serialize, index or sign publishes nothing and leaves no worker or open file.', async (t) => {
  const directory = await workspace(t)
  const failing = await signer(t, 500)
  await writeFile(join(directory, 'beside'), 'kept')

  const unserializable = exchanges()
  const body = unserializable[0].response.body
  let reads = 0
  body.subarray = function (...args) {
    if (++reads > Math.ceil(body.length / MiB) + 1) throw new Error('fixture read failure')
    return Buffer.prototype.subarray.apply(this, args)
  }

  // A WARC that is there for the generator to list but cannot be read by its indexing worker.
  class Unindexable extends Scoop {
    async toWARCFile (path, gzip) {
      await super.toWARCFile(path, gzip)
      await rm(path)
      await mkdir(path)
    }
  }

  const cases = {
    serialization: { run: path => syntheticCapture(unserializable).toWACZFile(path, false, { url: failing.url }), message: /creating underlying WARC file \(fixture read failure\)/, workers: 0, signed: 0 },
    indexing: { run: path => syntheticCapture(exchanges(), { Class: Unindexable }).toWACZFile(path, false, { url: failing.url }), message: /processing WACZ file/, workers: 1, signed: 0 },
    signing: { run: path => syntheticCapture(exchanges()).toWACZFile(path, true, { url: failing.url }), message: /processing WACZ file/, workers: 1, signed: 1 }
  }

  for (const [name, { run, message, workers: expectedWorkers, signed }] of Object.entries(cases)) {
    failing.requests.length = 0
    const path = join(directory, `${name}.wacz`)
    const { result, workers } = await watchingWorkers(() => run(path))

    assert.match(result.error?.message, message, name)
    assert.equal(workers.length, expectedWorkers, name)
    assert.ok(workers.every(worker => worker.threadId === -1), name)
    assert.equal(failing.requests.length, signed, name)
    await assert.rejects(lstat(path), { code: 'ENOENT' }, name)
    assert.deepEqual(await readdir(directory), ['beside'], name)
    assert.deepEqual(await openFilesUnder(directory), [], name)
  }
})

test('A write refused by the system fails the export with its code and leaves nothing behind.', { timeout: 60000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('Needs a POSIX shell to limit the size of files.')
    return
  }

  // The kernel refuses to grow a file past 4096 blocks: 2 or 4 MiB depending on
  // the shell, and less than the 8 MiB of bodies either way.
  const directory = await workspace(t)
  const limited = (...args) => promisify(execFile)('sh', ['-c', 'ulimit -f 4096 && exec "$@"', 'sh', process.execPath, FAIL_FIXTURE, ...args], { timeout: 30000 })

  for (const format of ['warc', 'wacz']) {
    const { stdout } = await limited(format, '8', join(directory, `capture.${format}`))
    const outcome = JSON.parse(stdout)

    assert.equal(outcome.published, false, format)
    assert.equal(outcome.code, 'EFBIG', format)
    assert.deepEqual(outcome.entries, [], format)
    if (format === 'wacz') {
      assert.match(outcome.message, /creating underlying WARC file/)
      assert.ok(outcome.causes.some(cause => cause.code === 'EFBIG' && cause.syscall === 'write'))
    }
  }
})

test('Running out of space fails the export with ENOSPC and leaves nothing behind.', { timeout: 60000 }, async (t) => {
  // A filesystem of a chosen size, mounted where only this test's processes see it.
  const directory = await workspace(t)
  const mounted = (size, ...command) => promisify(execFile)('unshare', ['--user', '--map-root-user', '--mount', 'sh', '-c', 'mount -t tmpfs -o size="$1" tmpfs "$2" && shift 2 && exec "$@"', 'sh', size, directory, ...command], { timeout: 30000 })

  try {
    await mounted('1m', 'true')
  } catch (err) {
    t.skip(`Cannot mount a filesystem in a user namespace here (${(err.stderr || err.message).trim().split('\n').at(-1)}).`)
    return
  }

  // 8 MiB of bodies: 4 MiB cannot hold the WARC; 12 MiB holds it, and not the WACZ as well.
  for (const [size, step] of [['4m', /creating underlying WARC file/], ['12m', /processing WACZ file|adding raw exchanges/]]) {
    const { stdout } = await mounted(size, process.execPath, FAIL_FIXTURE, 'wacz', '8', join(directory, 'capture.wacz'))
    const outcome = JSON.parse(stdout)

    assert.equal(outcome.published, false, size)
    assert.equal(outcome.code, 'ENOSPC', size)
    assert.match(outcome.message, step, size)
    assert.ok(outcome.causes.some(cause => cause.code === 'ENOSPC'), size)
    assert.deepEqual(outcome.entries, [], size)
  }

  // The same export has room in 64 MiB.
  const { stdout } = await mounted('64m', process.execPath, FAIL_FIXTURE, 'wacz', '8', join(directory, 'capture.wacz'))
  assert.deepEqual(JSON.parse(stdout), { published: true, entries: ['capture.wacz'] })
})
