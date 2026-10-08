import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WARCRecord } from 'warcio'

import indexWARC from './indexWARC.js'
import { Scoop } from '../Scoop.js'
import { FIXTURES_PATH } from '../constants.js'
import { parseCDXJ } from '../utils/fixtures/export/archive.mjs'
import { MiB, attachment, proxyExchange, syntheticCapture } from '../utils/fixtures/export/capture.mjs'

// The worker this one stands in for, from the copy of js-wacz that Scoop uses.
const { default: bundledIndexWARC } = await import(new URL('./workers/indexWARC.js', import.meta.resolve('@harvard-lil/js-wacz')))

async function workspace (t) {
  const directory = await mkdtemp(join(tmpdir(), 'scoop-index-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Requests whose index entries are derived from their bodies, each in its own way. */
function requestsWithBodies () {
  const post = (path, requestType, requestBody, seed) =>
    proxyExchange(`https://fixture.example/${path}`, 200, { seed, method: 'POST', requestType, requestBody, date: new Date(Date.parse('2026-10-03T10:00:10.000Z') + seed * 1000) })

  return [
    proxyExchange('https://fixture.example/', 2 * MiB, { seed: 1, type: 'text/html' }),
    post('form', 'application/x-www-form-urlencoded', 'name=value&other=1', 2),
    post('json', 'application/json', JSON.stringify({ query: 'items', page: 2, nested: { a: [1, 2] } }), 3),
    post('text', 'text/plain', 'plain request body', 4),
    post('multipart', 'multipart/form-data; boundary=fixture', '--fixture\r\nContent-Disposition: form-data; name="field"\r\n\r\ncontent\r\n--fixture--\r\n', 5),
    post('binary', 'application/octet-stream', 'opaque bytes', 6),
    proxyExchange('https://fixture.example/put', 10, { seed: 7, method: 'PUT', requestType: 'application/json', requestBody: '{"a":1}', date: new Date('2026-10-03T10:00:20.000Z') }),
    proxyExchange('https://fixture.example/a.png', 5000, { seed: 8, type: 'image/png', date: new Date('2026-10-03T10:00:21.000Z') }),
    proxyExchange('https://fixture.example/b.png', 5000, { seed: 8, type: 'image/png', date: new Date('2026-10-03T10:00:22.000Z') }),
    attachment('screenshot.png', 3000, { seed: 9, type: 'image/png', isEntryPoint: true })
  ]
}

test('indexWARC returns the entries of the js-wacz worker it stands in for.', async (t) => {
  const directory = await workspace(t)
  const captures = {
    recorded: await Scoop.fromWACZ(`${FIXTURES_PATH}example.com.wacz`),
    noarchive: await Scoop.fromWACZ(`${FIXTURES_PATH}noarchive.netlify.app.wacz`),
    requests: syntheticCapture(requestsWithBodies()),
    deduplicated: syntheticCapture(requestsWithBodies(), { options: { deduplicatePayloads: true } })
  }

  for (const [name, capture] of Object.entries(captures)) {
    for (const gzip of [true, false]) {
      const filename = join(directory, `${name}.warc${gzip ? '.gz' : ''}`)
      await capture.toWARCFile(filename, gzip)

      const actual = await indexWARC({ filename })
      const expected = await bundledIndexWARC({ filename, detectPages: false })

      assert.ok(expected.cdx.length > 0, filename)
      assert.deepEqual(actual, expected, filename)
    }
  }

  // The fixtures do reach the rules that read a request's body, and revisits.
  const entries = parseCDXJ((await indexWARC({ filename: join(directory, 'deduplicated.warc.gz') })).cdx.join(''))
  assert.deepEqual(entries.filter(entry => entry.method).map(entry => entry.method), ['POST', 'POST', 'POST', 'POST', 'POST', 'PUT'])
  assert.ok(entries.filter(entry => entry.method).every(entry => /__wb_method=(post|put)/.test(entry.urlkey)))
  const requestBody = path => entries.find(entry => entry.url === `https://fixture.example/${path}`).requestBody
  assert.equal(requestBody('form'), 'name=value&other=1')
  assert.equal(requestBody('multipart'), 'field=content')
  assert.equal(requestBody('put'), 'a=1')
  assert.equal(entries.filter(entry => entry.mime === 'warc/revisit').length, 1)
})

test('indexWARC reads requests whole, and no other record.', async (t) => {
  const directory = await workspace(t)
  const filename = join(directory, 'capture.warc.gz')
  await syntheticCapture(requestsWithBodies(), { options: { deduplicatePayloads: true } }).toWARCFile(filename, true)

  const read = []
  const readFully = WARCRecord.prototype.readFully
  t.mock.method(WARCRecord.prototype, 'readFully', function (...args) {
    read.push(this.warcType)
    return readFully.apply(this, args)
  })

  const { cdx } = await indexWARC({ filename })

  assert.equal(cdx.length, 10)
  assert.equal(read.length, 9)
  assert.ok(read.every(type => type === 'request'))
})

test('indexWARC rejects, and closes the file, when it cannot be read as a WARC.', async (t) => {
  const directory = await workspace(t)
  await assert.rejects(indexWARC({ filename: join(directory, 'missing.warc.gz') }), { code: 'ENOENT' })
  await assert.rejects(indexWARC({ filename: directory }), { code: 'EISDIR' })
})
