import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CaptureTlsErrors, tlsValidationError, validateCaptureErrors } from './tls-errors.js'

const expired = () => Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })

test('certificate classification preserves causes and excludes negotiation, policy and transport errors', () => {
  const original = expired()
  assert.equal(tlsValidationError(new Error('wrapper', { cause: original })), original)
  for (const code of ['EPROTO', 'ECONNRESET', 'ENOTFOUND', 'ERR_NETWORK_POLICY', 'ETIMEDOUT']) {
    assert.equal(tlsValidationError(Object.assign(new Error('TLS certificate failed'), { code })), null)
  }
  const cycle = new Error('cycle')
  cycle.cause = cycle
  assert.equal(tlsValidationError(cycle), null)
})

test('admitted request ownership survives duplicate errors and downstream closure, not a later attempt', () => {
  const ledger = new CaptureTlsErrors()
  const first = { id: 'page-0001' }
  const next = { id: 'page-0002' }
  ledger.begin(first)
  const request = { method: 'CONNECT', socket: { destroyed: true } }
  ledger.admit(request, 'https://localhost:443/')
  assert.equal(ledger.proxyError(expired(), request), true)
  assert.equal(ledger.proxyError(expired(), request), true)
  assert.equal(ledger.errors.length, 1)
  assert.equal(ledger.errors[0].pageId, first.id)
  assert.equal(ledger.errors[0].url, null)
  const late = { method: 'GET' }
  ledger.admit(late, 'https://localhost/late')
  ledger.end(first)
  ledger.begin(next)
  ledger.proxyError(expired(), late)
  assert.equal(ledger.errors[1].pageId, null)
  assert.equal(ledger.partial(next), false)
  const snapshot = ledger.errors
  snapshot[0].hostname = 'changed'
  assert.equal(ledger.errors[0].hostname, 'localhost')
})

test('CONNECT with competing same-origin resource evidence cannot fail the primary target', () => {
  const ledger = new CaptureTlsErrors()
  const context = new EventEmitter()
  const frame = {}
  const run = { id: 'page-0001' }
  ledger.begin(run, { mainFrame: () => frame })
  const unobserve = ledger.observe(context)
  const browserRequest = primary => ({ isNavigationRequest: () => primary, frame: () => frame, url: () => 'https://localhost/resource', method: () => 'GET' })
  context.emit('request', browserRequest(true))
  context.emit('request', browserRequest(false))
  const request = { method: 'CONNECT' }
  ledger.admit(request, 'https://localhost/')
  ledger.proxyError(expired(), request)
  assert.equal(ledger.failed(run), null)
  assert.equal(ledger.partial(run), true)
  unobserve()
  assert.equal(context.listenerCount('request'), 0)
})

test('archive diagnostics reject executable or inconsistent destination/page metadata', () => {
  const entry = { kind: 'tls_validation_failed', code: 'CERT_HAS_EXPIRED', message: 'expired', phase: 'proxy', url: 'https://localhost/', hostname: 'localhost', port: 443, pageId: null }
  assert.deepEqual(validateCaptureErrors([entry]), [entry])
  for (const patch of [{ url: 'file:///etc/passwd' }, { url: 'https://user:secret@localhost/' }, { hostname: 'other.test' }, { port: 0 }, { pageId: 'page-0001' }, { code: 'ETIMEDOUT' }, { phase: 'browser' }]) {
    assert.throws(() => validateCaptureErrors([{ ...entry, ...patch }]), /TLS diagnostics/)
  }
  assert.throws(() => validateCaptureErrors(null), /TLS diagnostics/)
})
