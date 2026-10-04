import { ScoopGeneratedExchange } from '../exchanges/ScoopGeneratedExchange.js'

const inventories = new WeakMap()
const reasons = new Set(['capture_timeout', 'capture_size_limit', 'navigation_error', 'page_closed', 'snapshot_timeout', 'non_web_capture', 'shared_setup_failed', 'session_failed'])
const pageFields = ['id', 'requestedUrl', 'resolvedUrl', 'startedAt', 'finishedAt', 'outcome', 'reason', 'httpStatus', 'contentType', 'pageInfo', 'entryPoint', 'attachments', 'steps']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const copy = value => JSON.parse(JSON.stringify(value))

export const pageId = index => `page-${String(index + 1).padStart(4, '0')}`

/** Validate without coercion, DNS, subprocesses or live network policy. */
export function validateUrls (urls) {
  if (!Array.isArray(urls) || !urls.length) throw new TypeError('URLs must be a non-empty array')
  const seen = new Map()
  return Array.from({ length: urls.length }, (_, index) => {
    const input = urls[index]
    const fail = detail => { throw new TypeError(`URL at index ${index}: ${detail}`) }
    if (!Object.hasOwn(urls, index) || typeof input !== 'string') fail('expected a primitive string in a dense array')
    if (!input || input.trim() !== input) fail('empty URL or surrounding whitespace')
    let url
    try { url = new URL(input) } catch { fail('expected an absolute HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol)) fail('expected HTTP(S)')
    if (url.username || url.password) fail('credentials are not allowed')
    if (seen.has(url.href)) fail(`duplicates serialized URL at index ${seen.get(url.href)}`)
    seen.set(url.href, index)
    return url.href
  })
}

export function initializeMultipage (capture, urls) {
  const data = {
    version: 2,
    startedAt: null,
    finishedAt: null,
    urls: [...urls],
    pages: urls.map((url, index) => ({
      id: pageId(index),
      requestedUrl: url,
      resolvedUrl: null,
      startedAt: null,
      finishedAt: null,
      outcome: 'pending',
      reason: null,
      httpStatus: null,
      contentType: null,
      pageInfo: {},
      entryPoint: null,
      attachments: {},
      steps: []
    }))
  }
  inventories.set(capture, { data, chains: new Map() })
  return data
}

/** Internal state; never expose this reference through the public API. */
export const multipageState = capture => inventories.get(capture)
export const multipageSnapshot = capture => inventories.has(capture) ? copy(inventories.get(capture).data) : undefined

export function restoreMultipage (capture, data) {
  validateInventory(data, capture.exchanges)
  inventories.set(capture, { data: copy(data), chains: new Map() })
}

export function artifactSummary (exchanges, owner) {
  const result = {}
  const single = {
    'screenshot.png': 'screenshot',
    'dom-snapshot.html': 'domSnapshot',
    'pdf-snapshot.pdf': 'pdfSnapshot',
    'video-extracted-summary.html': 'videoExtractedSummary',
    'video-extracted-metadata.json': 'videoExtractedMetadata',
    'provenance-summary.html': 'provenanceSummary'
  }
  for (const exchange of exchanges) {
    if (!(exchange instanceof ScoopGeneratedExchange) || (exchange.pageId || null) !== owner) continue
    const filename = exchange.url.slice('file:///'.length)
    const local = owner ? filename.slice(owner.length + 1) : filename
    if (single[local]) result[single[local]] = filename
    else {
      const key = local.endsWith('.mp4') ? 'videoExtracted' : local.endsWith('.vtt') ? 'videoExtractedSubtitles' : local.endsWith('.pem') ? 'certificates' : null
      if (key) (result[key] ||= []).push(filename)
    }
  }
  return result
}

export function validateSource (exchange, inventory) {
  const { pageId: id, sourceUrl } = exchange
  if (id == null && sourceUrl == null) return
  if (typeof id !== 'string' || !/^page-[0-9]{4,}$/.test(id) || typeof sourceUrl !== 'string' || /[\r\n]/.test(sourceUrl)) throw new Error('Invalid generated artifact page/source fields')
  const [url] = validateUrls([sourceUrl])
  if (url !== sourceUrl || (inventory && !inventory.pages.some(p => p.id === id && p.requestedUrl === sourceUrl))) throw new Error('Conflicting artifact page/source association')
}

/** Validate JSON metadata and its retained artifact references before import/export. */
export function validateInventory (data, exchanges, trace) {
  const fail = detail => { throw new Error(`Invalid multipage inventory: ${detail}`) }
  const date = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) fail('invalid UTC date')
    const ms = Date.parse(value)
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) fail('invalid date')
    return ms
  }
  if (!object(data) || ![1, 2].includes(data.version)) fail('unsupported version')
  const allowedReason = reason => reasons.has(reason) || (data.version === 2 && reason === 'tls_validation_failed')
  const urls = validateUrls(data.urls)
  if (!Array.isArray(data.pages) || data.pages.length !== urls.length) fail('URL/page count')
  const start = date(data.startedAt)
  const end = date(data.finishedAt)
  if (end < start) fail('inverted capture interval')
  const ids = new Set()
  const validateStep = step => {
    if (!object(step) || !/^step-[0-9]{4,}$/.test(step.id) || Number(step.id.slice(5)) < 1 || step.id !== `step-${String(Number(step.id.slice(5))).padStart(4, '0')}` || typeof step.name !== 'string') fail('step identity')
    const timestamp = date(step.startedAt)
    if (!Number.isFinite(step.durationMs) || step.durationMs < 0) fail('step duration')
    if (!['completed', 'failed', 'limit', 'interrupted', 'skipped'].includes(step.outcome)) fail('step outcome')
    if (['completed', 'failed'].includes(step.outcome)) {
      if (step.reason !== null) fail('step reason')
    } else if (step.outcome === 'skipped') {
      if (!(allowedReason(step.reason) || step.reason === 'not_applicable')) fail('step reason')
    } else if (!['capture_timeout', 'capture_size_limit', 'snapshot_timeout', 'non_web_capture'].includes(step.reason)) fail('step limit reason')
    return timestamp
  }
  const references = new Set()
  const artifacts = new Map()
  for (const exchange of exchanges) {
    if (!(exchange instanceof ScoopGeneratedExchange)) continue
    validateSource(exchange, data)
    if (artifacts.has(exchange.url)) fail('duplicate artifact URL')
    artifacts.set(exchange.url, exchange)
  }
  for (const [index, page] of data.pages.entries()) {
    if (!object(page) || pageFields.some(field => !Object.hasOwn(page, field))) fail('missing page fields')
    if (page.id !== pageId(index) || page.requestedUrl !== urls[index] || data.urls[index] !== urls[index]) fail('page identity/order')
    if (!['complete', 'partial', 'failed', 'skipped'].includes(page.outcome)) fail('nonterminal outcome')
    if (page.outcome === 'complete' ? page.reason !== null : !allowedReason(page.reason)) fail('page reason')
    if (!object(page.pageInfo) || 'favicon' in page.pageInfo || !object(page.attachments) || !Array.isArray(page.steps)) fail('page information/attachments/steps')
    if (page.resolvedUrl !== null) {
      try { if (!['http:', 'https:'].includes(new URL(page.resolvedUrl).protocol)) fail('response URL') } catch { fail('response URL') }
    }
    if (page.httpStatus !== null && (!Number.isInteger(page.httpStatus) || page.httpStatus < 100 || page.httpStatus > 599)) fail('HTTP status')
    if (page.contentType !== null && typeof page.contentType !== 'string') fail('content type')
    if (page.resolvedUrl === null && (page.httpStatus !== null || page.contentType !== null)) fail('response metadata without URL')
    if (page.outcome === 'skipped') {
      if ([page.startedAt, page.finishedAt, page.resolvedUrl, page.httpStatus, page.contentType, page.entryPoint].some(v => v !== null) || page.steps.length || Object.keys(page.pageInfo).length || Object.keys(page.attachments).length) fail('skipped page data')
    } else {
      const a = date(page.startedAt)
      const b = date(page.finishedAt)
      if (a < start || b < a || b > end) fail('page interval')
      for (const step of page.steps) {
        const t = validateStep(step)
        if (ids.has(step.id) || step.pageId !== page.id) fail('step identity/ownership')
        ids.add(step.id)
        if (t < a || t > b) fail('step interval')
      }
    }
    if (page.entryPoint !== null) {
      if (!object(page.entryPoint) || page.entryPoint.url !== page.requestedUrl || page.resolvedUrl === null) fail('entry point')
      const ts = date(page.entryPoint.ts)
      if (ts < date(page.startedAt) || ts > date(page.finishedAt)) fail('entry timestamp')
    }
    for (const value of Object.values(page.attachments)) {
      for (const name of Array.isArray(value) ? value : [value]) {
        if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || references.has(name)) fail('unsafe/conflicting artifact reference')
        const ex = artifacts.get(`file:///${name}`)
        if (!ex || ex.pageId !== page.id || ex.sourceUrl !== page.requestedUrl) fail('missing/conflicting artifact')
        references.add(name)
      }
    }
    if (trace && JSON.stringify(trace.filter(s => s.pageId === page.id)) !== JSON.stringify(page.steps)) fail('step projection')
  }
  for (const ex of artifacts.values()) if (ex.pageId && !references.has(ex.url.slice(8))) fail('unreferenced page artifact')
  if (trace) {
    const all = new Set()
    for (const step of trace) {
      if (validateStep(step) < start) fail('trace interval')
      if (all.has(step.id) || (step.pageId !== null && !ids.has(step.id))) fail('trace ownership/duplicates')
      all.add(step.id)
    }
  }
  return data
}
