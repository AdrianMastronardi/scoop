import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { WARCSerializer } from 'warcio'

import { Scoop } from '../Scoop.js'
import * as CONSTANTS from '../constants.js'
import * as exporters from './index.js'
import { scoopToWARCChunks, scoopToWARCFile } from './scoopToWARC.js'
import { publishFile } from './file-output.js'
import { readWARC } from '../utils/fixtures/export/archive.mjs'
import { MiB, attachment, proxyExchange, sha256, syntheticCapture } from '../utils/fixtures/export/capture.mjs'

const silent = { warn () {}, trace () {} }

async function workspace (t) {
  const directory = await mkdtemp(join(tmpdir(), 'scoop-warc-file-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Exchanges whose bodies span several views, one view and none at all. */
function exchanges () {
  return [
    proxyExchange('https://fixture.example/', 2.5 * MiB, { seed: 1, type: 'text/html', responseHeaders: { 'set-cookie': 'session=1; Path=/' } }),
    proxyExchange('https://fixture.example/form?step=1', 300, { seed: 2, method: 'POST', requestBody: 'name=value&other=1', requestType: 'application/x-www-form-urlencoded' }),
    proxyExchange('https://fixture.example/empty', 0, { seed: 3 }),
    attachment('screenshot.png', 70000, { seed: 4, type: 'image/png', description: 'Capture Time Screenshot', isEntryPoint: true })
  ]
}

/** What a record says, but for the identifier and date that every export draws anew. */
function comparable (record) {
  return {
    version: record.version,
    type: record.type,
    warc: record.warc.fields.filter(([name]) => name !== 'warc-record-id' && !(record.type === 'warcinfo' && name === 'warc-date')),
    block: sha256(record.block)
  }
}

for (const gzip of [false, true]) {
  test(`scoopToWARCFile writes every record, header and body (gzip: ${gzip}).`, async (t) => {
    const directory = await workspace(t)
    const path = join(directory, gzip ? 'capture.warc.gz' : 'capture.warc')
    const capture = syntheticCapture(exchanges())

    assert.equal(await capture.toWARCFile(path, gzip), undefined)

    const records = readWARC(await readFile(path), gzip)
    const [info, ...rest] = records
    assert.equal(info.type, 'warcinfo')
    assert.equal(info.warc.get('warc-filename'), 'archive.warc')
    assert.equal(info.block.toString(), `software: ${CONSTANTS.SOFTWARE} ${CONSTANTS.VERSION}\r\n`)
    assert.ok(records.every(record => record.version === `WARC/${CONSTANTS.WARC_VERSION}`))

    const expected = capture.exchanges.flatMap(exchange =>
      ['request', 'response'].filter(type => exchange[type]).map(type => ({ exchange, type, message: exchange[type] })))
    assert.deepEqual(rest.map(record => record.type), expected.map(({ type }) => type))

    for (const [index, { exchange, type, message }] of expected.entries()) {
      const record = rest[index]
      assert.equal(record.warc.get('warc-target-uri'), exchange.url)
      assert.equal(record.warc.get('warc-date'), exchange.date.toISOString())
      assert.equal(record.warc.get(CONSTANTS.EXCHANGE_ID_HEADER_LABEL.toLowerCase()), exchange.id)
      assert.equal(record.warc.get('content-type'), `application/http; msgtype=${type}`)
      assert.equal(record.warc.get('warc-block-digest'), sha256(record.block))
      assert.equal(record.warc.get('warc-payload-digest'), sha256(message.body))
      assert.equal(record.http.startLine, message.startLine)
      assert.deepEqual(record.http.fields, [...message.headers.entries()])
      assert.ok(record.payload.equals(message.body))
    }

    const generated = rest.at(-1)
    assert.equal(generated.warc.get('warc-refers-to-target-uri'), capture.url)
    assert.equal(generated.warc.get(CONSTANTS.EXCHANGE_DESCRIPTION_HEADER_LABEL.toLowerCase()), 'Capture Time Screenshot')

    // The same records as the export that returns bytes.
    const returned = readWARC(Buffer.from(await capture.toWARC(gzip)), gzip)
    assert.deepEqual(records.map(comparable), returned.map(comparable))

    assert.deepEqual(await readdir(directory), [relative(directory, path)])
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600)
    }
  })
}

test('scoopToWARCFile is exported, takes a relative path and accepts the states scoopToWARC does.', async (t) => {
  const directory = await workspace(t)
  assert.equal(exporters.scoopToWARCFile, scoopToWARCFile)
  assert.equal(exporters.scoopToWARCChunks, undefined)

  for (const state of ['PARTIAL', 'COMPLETE', 'RECONSTRUCTED']) {
    const path = join(directory, `${state}.warc`)
    await scoopToWARCFile(syntheticCapture(exchanges(), { state: Scoop.states[state] }), relative(process.cwd(), path))
    assert.equal(readWARC(await readFile(path), false).length, 8)
  }
})

test('scoopToWARCFile rejects an invalid capture or path before writing anything.', async (t) => {
  const directory = await workspace(t)
  const capture = syntheticCapture(exchanges())
  t.mock.method(WARCSerializer.prototype, 'digestRecord', () => assert.fail('must not serialize'))

  for (const invalid of [{}, true, null, 'FOO', syntheticCapture([], { state: Scoop.states.FAILED }), syntheticCapture([], { state: Scoop.states.INIT })]) {
    await assert.rejects(scoopToWARCFile(invalid, join(directory, 'capture.warc')), /"capture" must be a partial or complete Scoop capture object/)
  }

  for (const invalid of ['', undefined, null, 12, Buffer.from('capture.warc'), new URL('file:///capture.warc'), ['capture.warc']]) {
    await assert.rejects(capture.toWARCFile(invalid), { name: 'TypeError', message: '"path" must be a non-empty string.' })
  }

  await assert.rejects(capture.toWARCFile(join(directory, 'missing', 'capture.warc')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(directory), [])
})

test('scoopToWARCFile leaves an existing destination or symbolic link as it is.', async (t) => {
  const directory = await workspace(t)
  const capture = syntheticCapture(exchanges())
  const existing = join(directory, 'existing.warc')
  const linked = join(directory, 'linked.warc')
  const dangling = join(directory, 'dangling.warc')
  await writeFile(existing, 'kept')
  await symlink(existing, linked)
  await symlink(join(directory, 'nowhere'), dangling)

  for (const path of [existing, linked, dangling, directory]) {
    await assert.rejects(capture.toWARCFile(path), { code: 'EEXIST' })
  }

  assert.equal(await readFile(existing, 'utf8'), 'kept')
  assert.equal(await readlink(linked), existing)
  assert.equal(await readlink(dangling), join(directory, 'nowhere'))
  assert.deepEqual((await readdir(directory)).sort(), ['dangling.warc', 'existing.warc', 'linked.warc'])
})

test('Of two exports to one destination, one publishes a complete file and the other fails with EEXIST.', async (t) => {
  const directory = await workspace(t)
  const path = join(directory, 'capture.warc.gz')
  const captures = [syntheticCapture(exchanges()), syntheticCapture(exchanges())]

  const outcomes = await Promise.allSettled(captures.map(capture => capture.toWARCFile(path, true)))

  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'EEXIST')

  // Whole, and the work of one export only: every record pairs with the same capture.
  const records = readWARC(await readFile(path), true)
  const winner = captures[outcomes.findIndex(outcome => outcome.status === 'fulfilled')]
  assert.equal(records.length, 8)
  assert.deepEqual(
    records.slice(1).map(record => record.warc.get('scoop-exchange-id')),
    winner.exchanges.flatMap(exchange => exchange.request ? [exchange.id, exchange.id] : [exchange.id])
  )
  assert.deepEqual(await readdir(directory), ['capture.warc.gz'])
})

test('The published file is the one the export produced, in a private directory beside it.', async (t) => {
  const directory = await workspace(t)
  const destination = join(directory, 'published')
  await writeFile(join(directory, 'beside'), 'kept')
  let inode

  await publishFile(destination, silent, async (staging) => {
    assert.equal(dirname(staging), directory)
    if (process.platform !== 'win32') {
      assert.equal((await stat(staging)).mode & 0o777, 0o700)
    }

    const produced = join(staging, 'produced')
    await writeFile(produced, 'bytes')
    inode = (await stat(produced)).ino
    return produced
  })

  assert.equal((await stat(destination)).ino, inode)
  assert.equal(await readFile(destination, 'utf8'), 'bytes')
  assert.equal(await readFile(join(directory, 'beside'), 'utf8'), 'kept')
  assert.deepEqual((await readdir(directory)).sort(), ['beside', 'published'])
})

test('A failed cleanup is reported as a warning and does not replace the outcome of the export.', async (t) => {
  if (process.platform === 'win32' || process.getuid() === 0) {
    t.skip('Needs a directory that its owner cannot empty.')
    return
  }

  const directory = await workspace(t)
  const warnings = []
  const log = { warn: message => warnings.push(message), trace () {} }
  let staging

  try {
    // What the export leaves in a directory that cannot be emptied outlives it.
    await assert.rejects(publishFile(join(directory, 'failed'), log, async (path) => {
      staging = path
      await writeFile(join(path, 'kept'), 'bytes')
      await chmod(path, 0o500)
      throw Object.assign(new Error('fixture failure'), { code: 'EFIXTURE' })
    }), { code: 'EFIXTURE' })

    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes(staging))
    assert.match(warnings[0], /could not be removed/)
    await assert.rejects(lstat(join(directory, 'failed')), { code: 'ENOENT' })
    assert.equal(await readFile(join(staging, 'kept'), 'utf8'), 'bytes')
  } finally {
    await chmod(staging, 0o700)
  }
})

test('scoopToWARCFile omits what cannot be serialized before it is written, and fails where strictness applies.', async (t) => {
  const directory = await workspace(t)
  const digestRecord = WARCSerializer.prototype.digestRecord
  t.mock.method(WARCSerializer.prototype, 'digestRecord', async function (...args) {
    if (this.record.warcType === 'response') throw new Error('injected serializer failure')
    return digestRecord.apply(this, args)
  })

  const lenient = join(directory, 'lenient.warc')
  await syntheticCapture(exchanges()).toWARCFile(lenient)
  assert.deepEqual(readWARC(await readFile(lenient), false).map(record => record.type), ['warcinfo', 'request', 'request', 'request'])

  const strict = join(directory, 'strict.warc')
  await assert.rejects(
    syntheticCapture(exchanges(), { options: { deduplicatePayloads: true } }).toWARCFile(strict),
    /injected serializer failure/
  )
  assert.deepEqual(await readdir(directory), ['lenient.warc'])
})

for (const gzip of [false, true]) {
  test(`A failure after part of a record is written fails the export and publishes nothing (gzip: ${gzip}).`, async (t) => {
    const directory = await workspace(t)
    const path = join(directory, 'capture.warc')
    const list = exchanges()

    // Reads whole for its digests, then fails once part of it has been written.
    const body = list[0].response.body
    const views = Math.ceil(body.length / MiB)
    let reads = 0
    body.subarray = function (...args) {
      if (++reads > views + 1) throw new Error('fixture read failure')
      return Buffer.prototype.subarray.apply(this, args)
    }

    await assert.rejects(syntheticCapture(list).toWARCFile(path, gzip), /fixture read failure/)
    assert.ok(reads > views + 1)
    assert.deepEqual(await readdir(directory), [])
  })
}

test('scoopToWARCFile stores deduplicated payloads as revisits only when asked to.', async (t) => {
  const directory = await workspace(t)
  const repeated = () => [
    proxyExchange('https://fixture.example/a.png', 5000, { seed: 9, type: 'image/png' }),
    proxyExchange('https://fixture.example/b.png', 5000, { seed: 9, type: 'image/png', date: new Date('2026-10-03T10:00:05.000Z') })
  ]

  for (const [deduplicatePayloads, types] of [[false, ['response', 'response']], [true, ['response', 'revisit']]]) {
    const path = join(directory, `${deduplicatePayloads}.warc.gz`)
    const capture = syntheticCapture(repeated(), { options: { deduplicatePayloads } })
    await capture.toWARCFile(path, true)

    const records = readWARC(await readFile(path), true).filter(record => record.type !== 'request' && record.type !== 'warcinfo')
    assert.deepEqual(records.map(record => record.type), types)
    assert.equal(records[0].warc.get('warc-payload-digest'), sha256(capture.exchanges[0].response.body))

    if (deduplicatePayloads) {
      const [source, revisit] = records
      assert.equal(revisit.payload.length, 0)
      assert.equal(revisit.warc.get('warc-refers-to'), source.warc.get('warc-record-id'))
      assert.equal(revisit.warc.get('warc-refers-to-target-uri'), capture.exchanges[0].url)
      assert.equal(revisit.warc.get('warc-payload-digest'), source.warc.get('warc-payload-digest'))
      assert.equal(revisit.warc.get('warc-block-digest'), sha256(revisit.block))
      assert.equal(revisit.warc.get('warc-truncated'), 'length')
    }
  }
})

for (const gzip of [false, true]) {
  test(`A slow destination holds the serialization back instead of queueing the archive (gzip: ${gzip}).`, async () => {
    const total = 24 * MiB
    const capture = syntheticCapture(Array.from({ length: 6 }, (_, index) =>
      proxyExchange(`https://fixture.example/${index}`, total / 6, { seed: index })))

    let produced = 0
    let accepted = 0
    let largestChunk = 0
    let highestQueue = 0
    let highestAhead = 0

    async function * counted (chunks) {
      for await (const chunk of chunks) {
        produced += chunk.length
        largestChunk = Math.max(largestChunk, chunk.length)
        highestAhead = Math.max(highestAhead, produced - accepted)
        yield chunk
      }
    }

    // Takes one chunk per turn of the event loop, however fast they are offered.
    const slow = new Writable({
      highWaterMark: 64 * 1024,
      write (chunk, _encoding, callback) {
        highestQueue = Math.max(highestQueue, slow.writableLength)
        setImmediate(() => {
          accepted += chunk.length
          callback()
        })
      }
    })

    await pipeline(counted(scoopToWARCChunks(capture, gzip)), slow)

    assert.ok(produced > total)
    assert.equal(accepted, produced)
    // No chunk is a whole record: each body here is 4 MiB.
    assert.ok(largestChunk <= MiB, `produced a chunk of ${largestChunk} bytes`)
    // At most the chunk being written and the one waiting behind it: a body
    // view of 1 MiB at the largest, whatever the size of the archive.
    assert.ok(highestAhead <= 2 * MiB + 64 * 1024, `ran ${highestAhead} bytes ahead of the destination`)
    assert.ok(highestQueue <= 2 * MiB + 64 * 1024, `queued ${highestQueue} bytes`)
  })
}
