// Synthetic captures for the export tests: no browser and no network.
import { createCipheriv, createHash } from 'node:crypto'

import { Scoop } from '../../../Scoop.js'
import { ScoopProxyExchange } from '../../../exchanges/ScoopProxyExchange.js'
import { ScoopGeneratedExchange } from '../../../exchanges/ScoopGeneratedExchange.js'
import { getBody } from '../../../utils/http.js'

export const MiB = 1024 * 1024

export const sha256 = data => 'sha256:' + createHash('sha256').update(data).digest('hex')

const zeros = Buffer.alloc(MiB)

/** Fills `target` with bytes that do not compress, and are the same for a given seed. */
function fill (target, seed) {
  const iv = Buffer.alloc(16)
  iv.writeUInt32BE(seed)
  const cipher = createCipheriv('aes-128-ctr', Buffer.alloc(16, 7), iv)
  for (let offset = 0; offset < target.length; offset += zeros.length) {
    cipher.update(zeros.subarray(0, Math.min(zeros.length, target.length - offset))).copy(target, offset)
  }
}

/** An intercepted exchange, raw and parsed, whose response body is `size` bytes long. */
export function proxyExchange (url, size, { seed = 0, date = new Date('2026-10-03T10:00:01.000Z'), method = 'GET', requestBody = '', requestType = 'text/plain', type = 'application/octet-stream', responseHeaders = {} } = {}) {
  const { host, pathname, search } = new URL(url)
  const requestHeaders = { host, ...(requestBody ? { 'content-type': requestType, 'content-length': String(Buffer.byteLength(requestBody)) } : {}) }
  const headers = { 'content-type': type, 'content-length': String(size), ...responseHeaders }
  const head = (startLine, fields) => `${startLine}\r\n${Object.entries(fields).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`

  const requestLine = `${method} ${pathname}${search} HTTP/1.1`
  const responseHead = Buffer.from(head('HTTP/1.1 200 OK', headers))
  const responseRaw = Buffer.allocUnsafe(responseHead.length + size)
  responseHead.copy(responseRaw)
  fill(responseRaw.subarray(responseHead.length), seed)

  const exchange = new ScoopProxyExchange({ url, date })
  exchange.requestRaw = Buffer.from(head(requestLine, requestHeaders) + requestBody)
  exchange.responseRaw = responseRaw
  exchange.request = { startLine: requestLine, headers: new Headers(requestHeaders), body: getBody(exchange.requestRaw) }
  exchange.response = { startLine: 'HTTP/1.1 200 OK', headers: new Headers(headers), body: getBody(responseRaw) }
  return exchange
}

/** A generated exchange, as Scoop adds for a screenshot or a summary. */
export function attachment (name, size, { seed = 0, date = new Date('2026-10-03T10:00:02.000Z'), type = 'application/octet-stream', description = '', isEntryPoint = false } = {}) {
  const body = Buffer.allocUnsafe(size)
  fill(body, seed)
  return new ScoopGeneratedExchange({
    url: `file:///${name}`,
    date,
    description,
    isEntryPoint,
    response: { startLine: 'HTTP/1.1 200 OK', headers: new Headers({ 'content-type': type }), body }
  })
}

/** A capture that never ran, holding these exchanges. */
export function syntheticCapture (exchanges, { state = Scoop.states.COMPLETE, options = {}, Class = Scoop } = {}) {
  const capture = new Class('https://fixture.example/', { ytDlpPath: process.execPath, cripPath: process.execPath, logLevel: 'silent', ...options })
  capture.state = state
  capture.startedAt = new Date('2026-10-03T10:00:00.000Z')
  capture.exchanges = exchanges
  return capture
}

/**
 * The exchanges of the memory reference capture: as many records, headers and
 * attachments whatever `totalBytes` is, a third of which is one response.
 */
export function referenceExchanges (totalBytes) {
  const responses = 24
  const attachments = ['screenshot.png', 'dom-snapshot.html', 'provenance-summary.html']
  const largest = Math.floor(totalBytes / 3)
  const share = Math.floor((totalBytes - largest) / (responses - 1 + attachments.length))
  const date = index => new Date(Date.parse('2026-10-03T10:00:00.000Z') + index * 1000)

  return [
    ...Array.from({ length: responses }, (_, index) =>
      proxyExchange(`https://fixture.example/resource/${index}`, index === 1 ? largest : share, { seed: index, date: date(index) })),
    ...attachments.map((name, index) =>
      attachment(name, share, { seed: responses + index, date: date(responses + index), description: `Fixture ${name}`, isEntryPoint: index < 2 }))
  ]
}
