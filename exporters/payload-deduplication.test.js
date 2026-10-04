import test from 'node:test'
import assert from 'node:assert/strict'
import { WARCParser, WARCSerializer } from 'warcio'
import { Scoop } from '../Scoop.js'
import { ScoopProxyExchange } from '../exchanges/ScoopProxyExchange.js'
import { ScoopGeneratedExchange } from '../exchanges/ScoopGeneratedExchange.js'
import { payloadDeduplicator } from './payload-deduplication.js'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

function exchange (url, body = 'payload', options = {}) {
  const headers = { 'content-length': String(Buffer.byteLength(body)), 'content-type': 'image/png', ...options.headers }
  const result = new ScoopProxyExchange({ url, date: new Date(options.date || '2026-10-03T10:00:00.100Z') })
  result.request = { startLine: `${options.method || 'GET'} ${url} HTTP/1.1`, headers: new Headers(), body: Buffer.alloc(0) }
  result.response = { startLine: `HTTP/1.1 ${options.status || 200} OK`, headers: new Headers(headers), body: Buffer.from(body) }
  return result
}

function capture (exchanges, enabled = true) {
  const value = new Scoop('https://fixture.example/', { ytDlpPath: process.execPath, cripPath: process.execPath, deduplicatePayloads: enabled, logLevel: 'silent' })
  value.state = Scoop.states.COMPLETE
  value.startedAt = new Date('2026-10-03T10:00:00.000Z')
  value.exchanges = exchanges
  return value
}

async function responses (bytes) {
  const result = []
  for await (const record of new WARCParser([bytes])) {
    if (['response', 'revisit'].includes(record.warcType)) {
      result.push({ type: record.warcType, id: record.warcHeader('WARC-Record-ID'), ref: record.warcHeader('WARC-Refers-To'), hash: record.warcHeader('WARC-Payload-Digest'), truncated: record.warcHeader('WARC-Truncated'), body: Buffer.from(await record.readFully(false)), headers: record.httpHeaders.headers })
    }
  }
  return result
}

test('disabled exports retain full responses; repeated enabled exports have direct references and unchanged buffers', async () => {
  const exchanges = [exchange('https://fixture.example/a'), exchange('https://fixture.example/b'), exchange('https://fixture.example/c')]
  for (const gzip of [false, true]) {
    const disabled = await responses(await capture(exchanges, false).toWARC(gzip))
    assert.deepEqual(disabled.map(r => r.type), ['response', 'response', 'response'])
    const value = capture(exchanges)
    for (let i = 0; i < 2; i++) {
      const enabled = await responses(await value.toWARC(gzip))
      assert.deepEqual(enabled.map(r => r.type), ['response', 'revisit', 'revisit'])
      assert.equal(enabled[1].ref, enabled[0].id)
      assert.equal(enabled[2].ref, enabled[0].id)
      assert.equal(enabled[1].hash, enabled[0].hash)
      assert.equal(enabled[1].truncated, 'length')
      assert.equal(enabled[1].body.length, 0)
    }
    assert.ok(exchanges.every(ex => ex.response.body.toString() === 'payload'))
  }
})

test('ineligible or incompatible representations remain full responses', async () => {
  const changes = [
    { method: 'POST' }, { status: 304 }, { status: 206 }, { headers: { 'content-range': 'bytes 0-6/10' } },
    { headers: { 'transfer-encoding': 'chunked' } }, { headers: { 'content-length': '1' } },
    { headers: { 'content-length': '7, 7' } }, { headers: { 'content-length': '' } },
    { headers: { 'content-type': 'image/png; charset=utf-8' } }, { headers: { 'content-encoding': 'gzip' } }
  ]
  for (const change of changes) {
    const result = await responses(await capture([exchange('https://fixture.example/a'), exchange('https://fixture.example/b', 'payload', change)]).toWARC())
    assert.deepEqual(result.map(r => r.type), ['response', 'response'], JSON.stringify(change))
  }
  const result = await responses(await capture([exchange('https://fixture.example/a', ''), exchange('https://fixture.example/b', '')]).toWARC())
  assert.deepEqual(result.map(r => r.type), ['response', 'response'])
  const generated = new ScoopGeneratedExchange({ url: 'file:///image.png', response: exchange('https://fixture.example/a').response })
  assert.deepEqual((await responses(await capture([exchange('https://fixture.example/a'), generated]).toWARC())).map(r => r.type), ['response', 'response'])
})

test('same-second conflicting source payload is never selected, including conflicts later in export order', async () => {
  const result = await responses(await capture([
    exchange('https://fixture.example/a'),
    exchange('https://fixture.example/b', 'payload', { date: '2026-10-03T10:00:01.000Z' }),
    exchange('https://fixture.example/a', 'changed', { date: '2026-10-03T10:00:00.800Z' })
  ]).toWARC())
  assert.deepEqual(result.map(r => r.type), ['response', 'response', 'response'])
})

test('digest collisions still require byte equality', () => {
  const a = exchange('https://fixture.example/a', 'one')
  const b = exchange('https://fixture.example/b', 'two')
  const lookup = payloadDeduplicator([a, b], () => 'sha256:collision')
  lookup.register(lookup.candidate(a), a, { warcHeader: () => 'source' })
  assert.equal(lookup.candidate(b).source, undefined)
})

test('serialization errors remain legacy omissions by default and fail explicitly with deduplication', async t => {
  const serialize = WARCSerializer.serialize.bind(WARCSerializer)
  t.mock.method(WARCSerializer, 'serialize', async (record, options) => {
    if (record.warcType === 'response') throw new Error('injected serializer failure')
    return serialize(record, options)
  })
  assert.equal((await responses(await capture([exchange('https://fixture.example/a')], false).toWARC())).length, 0)
  await assert.rejects(capture([exchange('https://fixture.example/a')]).toWARC(), /injected serializer failure/)
})

test('encoded revisits retain current headers and have valid own block digests and lengths', async () => {
  const encoded = gzipSync(Buffer.from('identical encoded body'))
  const a = exchange('https://fixture.example/a', encoded, { headers: { 'content-encoding': 'gzip', etag: 'first', 'set-cookie': 'session=first' } })
  const b = exchange('https://fixture.example/b', encoded, { headers: { 'content-encoding': 'gzip', etag: 'second', 'set-cookie': 'session=second', date: 'Sat, 03 Oct 2026 10:00:01 GMT' }, date: '2026-10-03T10:00:01.000Z' })
  for (const gzip of [false, true]) {
    let source
    for await (const record of new WARCParser([await capture([a, b]).toWARC(gzip)])) {
      if (record.warcType === 'response') source = { id: record.warcHeader('WARC-Record-ID'), date: record.warcDate, digest: record.warcHeader('WARC-Payload-Digest') }
      if (record.warcType !== 'revisit') continue
      const body = Buffer.from(await record.readFully(false))
      assert.equal(body.length, 0)
      const block = Buffer.from(record.httpHeaders.toString() + '\r\n')
      assert.equal(Number(record.warcHeader('Content-Length')), block.length)
      assert.equal(record.warcHeader('WARC-Block-Digest'), 'sha256:' + createHash('sha256').update(block).digest('hex'))
      assert.equal(record.warcHeader('WARC-Payload-Digest'), source.digest)
      assert.equal(record.warcHeader('WARC-Refers-To'), source.id)
      assert.equal(record.warcHeader('WARC-Refers-To-Date'), source.date)
      assert.equal(record.warcHeader('WARC-Refers-To-Target-URI'), a.url)
      assert.equal(record.warcHeader('WARC-Profile'), 'http://netpreserve.org/warc/1.1/revisit/identical-payload-digest')
      assert.equal(record.warcHeader('Scoop-Exchange-ID'), b.id)
      assert.equal(record.warcDate, b.date.toISOString())
      assert.equal(record.httpHeaders.headers.get('set-cookie'), 'session=second')
      assert.equal(record.httpHeaders.headers.get('etag'), 'second')
      assert.equal(record.httpHeaders.headers.get('date'), 'Sat, 03 Oct 2026 10:00:01 GMT')
    }
  }
})

test('a legacy digest-named raw entry never takes an empty revisit payload', async t => {
  const a = exchange('https://fixture.example/a')
  const b = exchange('https://fixture.example/b')
  const bytes = await capture([a, b]).toWARC()
  const hash = 'sha256:' + createHash('sha256').update('payload').digest('hex')
  const zip = new AdmZip()
  zip.addFile('datapackage.json', Buffer.from(JSON.stringify({ mainPageUrl: a.url, mainPageDate: a.date.toISOString() })))
  zip.addFile('archive/data.warc', Buffer.from(bytes))
  const request = Buffer.from(`GET ${a.url} HTTP/1.1\r\nHost: fixture.example\r\n\r\n`)
  const head = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 7\r\n\r\n')
  zip.addFile(`raw/request_${a.date.toISOString()}_${a.id}`, request)
  zip.addFile(`raw/response_${a.date.toISOString()}_${a.id}_${hash}`, head)
  const directory = await mkdtemp(join(tmpdir(), 'scoop-legacy-revisit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'capture.wacz')
  await writeFile(path, zip.toBuffer())
  const restored = await Scoop.fromWACZ(path)
  assert.deepEqual(restored.exchanges[0].requestRaw, request)
  assert.deepEqual(restored.exchanges[0].responseRaw, Buffer.concat([head, Buffer.from('payload')]))
})

test('duplicate length fields exclude deduplication and revisits retain separate Set-Cookie fields', async () => {
  const a = exchange('https://fixture.example/a')
  const b = exchange('https://fixture.example/b')
  b._responseParsed = { rawHeaders: ['Content-Length', '7', 'Content-Length', '7', 'Content-Type', 'image/png'] }
  assert.deepEqual((await responses(await capture([a, b]).toWARC())).map(r => r.type), ['response', 'response'])
  b._responseParsed.rawHeaders = ['Content-Length', '7', 'Content-Type', 'image/png', 'Set-Cookie', 'a=1; Path=/', 'Set-Cookie', 'b=2; Path=/']
  for await (const record of new WARCParser([await capture([a, b]).toWARC()])) {
    if (record.warcType !== 'revisit') continue
    assert.deepEqual([...record.httpHeaders.headers].filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value), ['a=1; Path=/', 'b=2; Path=/'])
  }
})
