import { ScoopGeneratedExchange } from '../exchanges/ScoopGeneratedExchange.js'

const inventories = new WeakMap()
const reasons = new Set(['capture_timeout', 'capture_size_limit', 'navigation_error', 'page_closed', 'snapshot_timeout', 'non_web_capture', 'shared_setup_failed', 'session_failed'])
const pageFields = ['id', 'requestedUrl', 'resolvedUrl', 'startedAt', 'finishedAt', 'outcome', 'reason', 'httpStatus', 'contentType', 'pageInfo', 'entryPoint', 'attachments', 'steps']
const attemptFields = ['pageId', 'attemptNumber', 'requestedUrl', 'resolvedUrl', 'startedAt', 'finishedAt', 'outcome', 'reason', 'httpStatus', 'contentType', 'pageInfo', 'entryPoint', 'exchangeIds', 'attachments', 'steps']
const limitReasons = ['capture_timeout', 'capture_size_limit', 'snapshot_timeout', 'non_web_capture']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const copy = value => JSON.parse(JSON.stringify(value))
const stepNumber = step => Number(step.id.slice(5))

/** What a page entry repeats of the last visit made to it. */
export const projectedFields = ['resolvedUrl', 'startedAt', 'finishedAt', 'outcome', 'reason', 'httpStatus', 'contentType', 'pageInfo', 'entryPoint', 'attachments', 'steps']

/** Visits a page can get: the first, and one more if its required artifacts are missing. */
export const MAX_ATTEMPTS = 2

/** Artifacts whose absence or invalidity `assessPageAttempt` can report. */
export const requiredArtifacts = ['screenshot', 'domSnapshot', 'certificates']

/** Why a step is `failed`, from version 3 on. Never an error message. */
export const stepFailureReasons = ['step_timeout', 'snapshot_timeout', 'navigation_error', 'page_closed', 'browser_disconnected', 'tls_validation_failed', 'network_policy_blocked', 'artifact_missing', 'artifact_invalid', 'artifact_generation_failed', 'step_failed']

/** Thrown by a step that knows why it failed, to be recorded as its reason in array mode. */
export class StepFailure extends Error {
  constructor (reason, options, message = reason) {
    super(message, options)
    this.reason = reason
  }
}

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
    version: 3,
    startedAt: null,
    finishedAt: null,
    urls: [...urls],
    globalSteps: [],
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
      steps: [],
      attempts: [],
      retryCount: 0
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

/** Every step an inventory records, in the order they ran. Versions 1 and 2 kept no global steps. */
export function inventorySteps (data) {
  const steps = data.version >= 3
    ? [...data.pages.flatMap(page => page.attempts.flatMap(attempt => attempt.steps)), ...data.globalSteps]
    : data.pages.flatMap(page => page.steps)
  return steps.sort((a, b) => stepNumber(a) - stepNumber(b))
}

/** `page-0001-` for a first visit, `page-0001-attempt-2-` for the next: what its artifact names start with. */
export const artifactPrefix = (owner, attemptNumber = 1) => attemptNumber > 1 ? `${owner}-attempt-${attemptNumber}-` : `${owner}-`

/** Check what `assessPageAttempt` returned, and copy it. */
export function validateAssessment (value) {
  if (!object(value) || !Array.isArray(value.missingArtifacts) || typeof value.retryAllowed !== 'boolean' ||
    value.missingArtifacts.some((artifact, index) => !requiredArtifacts.includes(artifact) || value.missingArtifacts.indexOf(artifact) !== index)) {
    throw new TypeError('Invalid page attempt assessment')
  }
  return { missingArtifacts: [...value.missingArtifacts], retryAllowed: value.retryAllowed }
}

/** Generated filenames by kind: of one visit to a page, or, without an owner, of the capture. */
export function artifactSummary (exchanges, owner, attemptNumber = 1) {
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
    if (owner && (exchange.attemptNumber || 1) !== attemptNumber) continue
    const filename = exchange.url.slice('file:///'.length)
    const local = owner ? filename.slice(artifactPrefix(owner, attemptNumber).length) : filename
    if (single[local]) result[single[local]] = filename
    else {
      const key = local.endsWith('.mp4') ? 'videoExtracted' : local.endsWith('.vtt') ? 'videoExtractedSubtitles' : local.endsWith('.pem') ? 'certificates' : null
      if (key) (result[key] ||= []).push(filename)
    }
  }
  return result
}

export function validateSource (exchange, inventory) {
  const { pageId: id, sourceUrl, attemptNumber } = exchange
  if (id == null && sourceUrl == null && attemptNumber == null) return
  if (typeof id !== 'string' || !/^page-[0-9]{4,}$/.test(id) || typeof sourceUrl !== 'string' || /[\r\n]/.test(sourceUrl) ||
    (attemptNumber != null && !(Number.isInteger(attemptNumber) && attemptNumber >= 1 && attemptNumber <= MAX_ATTEMPTS))) throw new Error('Invalid generated artifact page/source fields')
  const [url] = validateUrls([sourceUrl])
  const page = inventory?.pages.find(p => p.id === id && p.requestedUrl === sourceUrl)
  if (url !== sourceUrl || (inventory && !page)) throw new Error('Conflicting artifact page/source association')
  // From version 3 on, a page artifact belongs to one of the visits made to its page.
  if (inventory?.version >= 3 && !page.attempts?.some(attempt => attempt.attemptNumber === attemptNumber)) throw new Error('Conflicting artifact page/source association')
}

const fail = detail => { throw new Error(`Invalid multipage inventory: ${detail}`) }
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) fail('invalid UTC date')
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) fail('invalid date')
  return ms
}

/**
 * Validate JSON metadata and its retained artifact references before import/export.
 * Each version keeps the rules it was written under: versions 1 and 2 know one visit per
 * page and no reason for a failed step, version 3 the history of visits and closed reasons.
 */
export function validateInventory (data, exchanges, trace) {
  if (!object(data) || ![1, 2, 3].includes(data.version)) fail('unsupported version')
  return data.version === 3 ? validateVisits(data, exchanges, trace) : validateSingleVisits(data, exchanges, trace)
}

/** Version 3. */
function validateVisits (data, exchanges, trace) {
  const allowedReason = reason => reasons.has(reason) || reason === 'tls_validation_failed' || reason === 'artifact_missing'
  const urls = validateUrls(data.urls)
  if (!Array.isArray(data.pages) || data.pages.length !== urls.length) fail('URL/page count')
  if (!Array.isArray(data.globalSteps)) fail('global steps')
  const start = date(data.startedAt)
  const end = date(data.finishedAt)
  if (end < start) fail('inverted capture interval')

  // A step is recorded once, by the visit it ran in or as a global step.
  const steps = new Map()
  const validateStep = (step, pageId, attemptNumber) => {
    if (!object(step) || !/^step-[0-9]{4,}$/.test(step.id) || stepNumber(step) < 1 || step.id !== `step-${String(stepNumber(step)).padStart(4, '0')}` || typeof step.name !== 'string') fail('step identity')
    if (steps.has(step.id) || step.pageId !== pageId || step.attemptNumber !== attemptNumber) fail('step identity/ownership')
    steps.set(step.id, step)
    const timestamp = date(step.startedAt)
    if (!Number.isFinite(step.durationMs) || step.durationMs < 0) fail('step duration')
    if (step.outcome === 'completed') {
      if (step.reason !== null) fail('step reason')
    } else if (step.outcome === 'failed') {
      if (!stepFailureReasons.includes(step.reason)) fail('step reason')
    } else if (step.outcome === 'skipped') {
      if (!(allowedReason(step.reason) || step.reason === 'not_applicable')) fail('step reason')
    } else if (['limit', 'interrupted'].includes(step.outcome)) {
      if (!limitReasons.includes(step.reason)) fail('step limit reason')
    } else fail('step outcome')
    return timestamp
  }

  const artifacts = new Map()
  const retained = new Set()
  for (const exchange of exchanges) {
    if (!(exchange instanceof ScoopGeneratedExchange)) { retained.add(exchange.id); continue }
    validateSource(exchange, data)
    if (artifacts.has(exchange.url)) fail('duplicate artifact URL')
    artifacts.set(exchange.url, exchange)
  }

  // An artifact or an exchange is evidence of one visit. The page entry repeating
  // what its last visit references is a projection, checked as such below.
  const claimedArtifacts = new Set()
  const claimedExchanges = new Set()
  for (const [index, page] of data.pages.entries()) {
    if (!object(page) || [...pageFields, 'attempts', 'retryCount'].some(field => !Object.hasOwn(page, field))) fail('missing page fields')
    if (page.id !== pageId(index) || page.requestedUrl !== urls[index] || data.urls[index] !== urls[index]) fail('page identity/order')
    if (!Array.isArray(page.attempts) || page.attempts.length > MAX_ATTEMPTS || page.retryCount !== Math.max(0, page.attempts.length - 1)) fail('visit count')
    if (!['complete', 'partial', 'failed', 'skipped'].includes(page.outcome)) fail('nonterminal outcome')
    if (!object(page.pageInfo) || !object(page.attachments) || !Array.isArray(page.steps)) fail('page information/attachments/steps')
    if (page.outcome === 'skipped') {
      if (!allowedReason(page.reason)) fail('page reason')
      if (page.attempts.length || [page.startedAt, page.finishedAt, page.resolvedUrl, page.httpStatus, page.contentType, page.entryPoint].some(v => v !== null) || page.steps.length || Object.keys(page.pageInfo).length || Object.keys(page.attachments).length) fail('skipped page data')
      continue
    }
    if (!page.attempts.length) fail('visit count')

    let previous = start
    for (const [position, attempt] of page.attempts.entries()) {
      const attemptNumber = position + 1
      if (!object(attempt) || attemptFields.some(field => !Object.hasOwn(attempt, field))) fail('missing visit fields')
      if (attempt.pageId !== page.id || attempt.attemptNumber !== attemptNumber || attempt.requestedUrl !== page.requestedUrl) fail('visit identity/order')
      if (!['complete', 'partial', 'failed'].includes(attempt.outcome)) fail('nonterminal visit outcome')
      if (attempt.outcome === 'complete' ? attempt.reason !== null : !allowedReason(attempt.reason)) fail('visit reason')
      const assessed = Object.hasOwn(attempt, 'missingArtifacts') || Object.hasOwn(attempt, 'retryAllowed')
      if (assessed) { try { validateAssessment(attempt) } catch { fail('visit assessment') } }
      // Only an assessment that names missing artifacts, and allows it, makes them the outcome.
      if (attempt.reason === 'artifact_missing' && !(attempt.outcome === 'failed' && assessed && attempt.retryAllowed && attempt.missingArtifacts.length)) fail('visit assessment')
      if (!object(attempt.pageInfo) || 'favicon' in attempt.pageInfo || !object(attempt.attachments) || !Array.isArray(attempt.steps) || !Array.isArray(attempt.exchangeIds)) fail('visit information/attachments/steps/exchanges')
      if (attempt.resolvedUrl !== null) {
        try { if (!['http:', 'https:'].includes(new URL(attempt.resolvedUrl).protocol)) fail('response URL') } catch { fail('response URL') }
      }
      if (attempt.httpStatus !== null && (!Number.isInteger(attempt.httpStatus) || attempt.httpStatus < 100 || attempt.httpStatus > 599)) fail('HTTP status')
      if (attempt.contentType !== null && typeof attempt.contentType !== 'string') fail('content type')
      if (attempt.resolvedUrl === null && (attempt.httpStatus !== null || attempt.contentType !== null)) fail('response metadata without URL')

      // Visits follow one another: none starts before the previous one has ended.
      const a = date(attempt.startedAt)
      const b = date(attempt.finishedAt)
      if (a < previous || b < a || b > end) fail('visit interval')
      previous = b
      for (const step of attempt.steps) {
        const t = validateStep(step, page.id, attemptNumber)
        if (t < a || t > b) fail('step interval')
      }
      if (attempt.entryPoint !== null) {
        if (!object(attempt.entryPoint) || attempt.entryPoint.url !== page.requestedUrl || attempt.resolvedUrl === null) fail('entry point')
        const ts = date(attempt.entryPoint.ts)
        if (ts < a || ts > b) fail('entry timestamp')
      }
      for (const value of Object.values(attempt.attachments)) {
        for (const name of Array.isArray(value) ? value : [value]) {
          if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || claimedArtifacts.has(name)) fail('unsafe/conflicting artifact reference')
          const ex = artifacts.get(`file:///${name}`)
          if (!ex || ex.pageId !== page.id || ex.sourceUrl !== page.requestedUrl || ex.attemptNumber !== attemptNumber) fail('missing/conflicting artifact')
          claimedArtifacts.add(name)
        }
      }
      for (const id of attempt.exchangeIds) {
        if (typeof id !== 'string' || claimedExchanges.has(id) || !retained.has(id)) fail('missing/conflicting exchange reference')
        claimedExchanges.add(id)
      }
    }

    // A second visit follows missing artifacts and nothing else: not an HTTP error,
    // nor any outcome that Scoop itself knows to rule a revisit out.
    const [first, second] = page.attempts
    if (second && (first.reason !== 'artifact_missing' || first.httpStatus >= 400)) fail('revisit after an excluded outcome')
    const last = page.attempts.at(-1)
    if (projectedFields.some(field => JSON.stringify(page[field]) !== JSON.stringify(last[field]))) fail('page projection')
  }
  for (const ex of artifacts.values()) if (ex.pageId && !claimedArtifacts.has(ex.url.slice(8))) fail('unreferenced page artifact')
  for (const step of data.globalSteps) if (validateStep(step, null, null) < start) fail('trace interval')
  if (trace && JSON.stringify(trace) !== JSON.stringify([...steps.values()].sort((a, b) => stepNumber(a) - stepNumber(b)))) fail('step trace')
  return data
}

/** Versions 1 and 2, as they were validated when they were the current ones. */
function validateSingleVisits (data, exchanges, trace) {
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
