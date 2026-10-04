import { createHash } from 'node:crypto'
import { ScoopGeneratedExchange } from '../exchanges/ScoopGeneratedExchange.js'

const digest = body => `sha256:${createHash('sha256').update(body).digest('hex')}`

/** Archive-local lookup. Captured bodies remain owned by their exchanges. */
export function payloadDeduplicator (exchanges, hashBody = digest) {
  const observations = new Map()
  const sources = new Map()
  for (const ex of exchanges) {
    if (ex instanceof ScoopGeneratedExchange || !ex.response) continue
    const key = `${ex.url}\n${Math.floor(ex.date.getTime() / 1000)}`
    const bodies = observations.get(key) || []
    bodies.push(ex.response.body)
    observations.set(key, bodies)
  }
  return {
    candidate (ex) {
      if (ex instanceof ScoopGeneratedExchange || ex.request?.startLine.split(' ')[0] !== 'GET') return null
      const msg = ex.response
      if (msg?.startLine.split(' ')[1] !== '200' || !msg.body?.length || msg.headers.has('transfer-encoding') || msg.headers.has('content-range')) return null
      const raw = ex.responseParsed?.rawHeaders
      if (raw && raw.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-length').length !== 1) return null
      const length = msg.headers.get('content-length')
      if (!length || !/^\d+$/.test(length) || Number(length) !== msg.body.length) return null
      const hash = hashBody(msg.body)
      const key = JSON.stringify([hash, msg.body.length, msg.headers.get('content-type'), msg.headers.get('content-encoding')])
      const source = sources.get(key)?.find(source => source.body.equals(msg.body))
      const unambiguous = observations.get(`${ex.url}\n${Math.floor(ex.date.getTime() / 1000)}`).every(body => body.equals(msg.body))
      return { hash, key, source, unambiguous }
    },
    register (candidate, exchange, record) {
      if (!candidate?.unambiguous || candidate.source) return
      const list = sources.get(candidate.key) || []
      list.push({ body: exchange.response.body, id: record.warcHeader('WARC-Record-ID'), url: exchange.url, date: exchange.date.toISOString() })
      sources.set(candidate.key, list)
    }
  }
}
