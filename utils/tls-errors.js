// Certificate verification failures only: negotiation, DNS and transport errors
// must retain their existing handling. Codes come from Node's X509 verification.
const certificateCodes = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'CERT_SIGNATURE_FAILURE', 'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED', 'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD', 'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG', 'CERT_REVOKED', 'INVALID_CA', 'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE', 'CERT_UNTRUSTED', 'CERT_REJECTED',
  'INVALID_NON_CA', 'KEYUSAGE_NO_CERTSIGN', 'UNHANDLED_CRITICAL_EXTENSION',
  'INVALID_POLICY_EXTENSION', 'NO_EXPLICIT_POLICY', 'DIFFERENT_CRL_SCOPE',
  'UNSUPPORTED_EXTENSION_FEATURE', 'UNNESTED_RESOURCE', 'PERMITTED_VIOLATION',
  'EXCLUDED_VIOLATION', 'SUBTREE_MINMAX', 'UNSUPPORTED_CONSTRAINT_TYPE',
  'UNSUPPORTED_CONSTRAINT_SYNTAX', 'UNSUPPORTED_NAME_SYNTAX', 'CRL_PATH_VALIDATION_ERROR',
  'EE_KEY_TOO_SMALL', 'CA_KEY_TOO_SMALL', 'CA_MD_TOO_WEAK'
])
const destinations = new WeakMap()
const hostname = url => url.hostname.replace(/^\[|\]$/g, '')
const networkUrl = input => { const url = new URL(input); url.hash = ''; return url.href }

/** Return the original certificate error, including through a wrapper's cause. */
export function tlsValidationError (error) {
  const seen = new Set()
  while (error && typeof error === 'object' && !seen.has(error)) {
    if (certificateCodes.has(error.code)) return error
    seen.add(error)
    error = error.cause
  }
  return null
}

/** Retain the failed HEAD redirect destination without replacing its Error. */
export function withTlsDestination (error, target) {
  if (tlsValidationError(error)) destinations.set(error, new URL(target))
  return error
}

/** Validate descriptive archive diagnostics; never use them as execution policy. */
export function validateCaptureErrors (entries, inventory) {
  const fail = () => { throw new Error('Invalid capture TLS diagnostics') }
  if (!Array.isArray(entries)) fail()
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || entry.kind !== 'tls_validation_failed' ||
      !certificateCodes.has(entry.code) || typeof entry.message !== 'string' ||
      !['head', 'proxy'].includes(entry.phase) || typeof entry.hostname !== 'string' ||
      !entry.hostname || /[\s/@?#]/.test(entry.hostname) ||
      !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) fail()
    let authority
    try {
      authority = new URL(`https://${entry.hostname.includes(':') ? '[' + entry.hostname + ']' : entry.hostname}:${entry.port}/`)
    } catch { fail() }
    if (hostname(authority) !== entry.hostname) fail()
    if (entry.url !== null) {
      let url
      try { url = new URL(entry.url) } catch { fail() }
      if (typeof entry.url !== 'string' || !['http:', 'https:'].includes(url.protocol) ||
        url.username || url.password || url.href !== entry.url || hostname(url) !== entry.hostname ||
        Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== entry.port) fail()
    }
    if (entry.pageId !== null && (!inventory || typeof entry.pageId !== 'string' ||
      !inventory.pages.some(page => page.id === entry.pageId))) fail()
    return {
      kind: entry.kind,
      code: entry.code,
      message: entry.message,
      phase: entry.phase,
      url: entry.url,
      hostname: entry.hostname,
      port: entry.port,
      pageId: entry.pageId
    }
  })
}

/** Internal request ownership and TLS outcome latches, separate from capture limits. */
export class CaptureTlsErrors {
  #entries = []
  #requests = new WeakMap()
  #seen = new WeakSet()
  #runs = new WeakMap()
  #active = null
  #browser = new Map()

  get errors () { return structuredClone(this.#entries) }
  get hasErrors () { return this.#entries.length > 0 }

  restore (entries, inventory) { this.#entries = validateCaptureErrors(entries, inventory) }

  begin (run, page, pageId = run.id || null) {
    this.#active = run
    this.#runs.set(run, { open: true, page, pageId, helper: false, error: null, partial: false })
  }

  end (run) {
    const scope = this.#runs.get(run)
    if (scope) scope.open = false
    if (this.#active === run) this.#active = null
    for (const [request, observation] of this.#browser) {
      if (observation.run === run) this.#browser.delete(request)
    }
  }

  failed (run) { return this.#runs.get(run)?.error || null }
  partial (run) { return this.#runs.get(run)?.partial === true }
  helper (run, active) { this.#runs.get(run).helper = active }

  /** Whether network policy refused the run's own target, on the way to it or through a redirect. */
  blocked (run) { return this.#runs.get(run)?.blocked === true }
  block (run) { const scope = this.#runs.get(run); if (scope?.open) scope.blocked = true }

  /** Called with every proxy error: a policy refusal of an admitted primary request marks its run. */
  policyError (error, request) {
    if (error?.code !== 'ERR_NETWORK_POLICY') return
    const owner = request && this.#requests.get(request)
    if (owner?.primary) this.block(owner.run)
  }

  /** Browser evidence disambiguates navigation; CONNECT authority alone cannot. */
  observe (context) {
    const onRequest = request => {
      const run = this.#active
      const scope = run && this.#runs.get(run)
      if (!scope?.open) return
      let primary = false
      try { primary = request.isNavigationRequest() && request.frame() === scope.page?.mainFrame() } catch {}
      this.#browser.set(request, { run, primary, url: networkUrl(request.url()), method: request.method() })
    }
    const done = request => this.#browser.delete(request)
    context.on('request', onRequest)
    context.on('requestfinished', done)
    context.on('requestfailed', done)
    return () => {
      context.off('request', onRequest)
      context.off('requestfinished', done)
      context.off('requestfailed', done)
      this.#browser.clear()
    }
  }

  #primary (request, target, run) {
    const scope = run && this.#runs.get(run)
    if (scope?.helper) return true
    const candidates = [...this.#browser.values()].filter(observation => {
      if (observation.run !== run) return false
      return request.method === 'CONNECT'
        ? new URL(observation.url).origin === target.origin
        : observation.url === networkUrl(target) && observation.method === request.method
    })
    return candidates.length === 1 && candidates[0].primary
  }

  /** Called before awaited DNS authorization, including CONNECT and helpers. */
  admit (request, target) {
    if (this.#requests.has(request)) return
    const url = new URL(target)
    const run = this.#active
    this.#requests.set(request, { run, target: url, primary: this.#primary(request, url, run) })
  }

  proxyError (error, request) {
    if (!tlsValidationError(error)) return false
    const owner = request && this.#requests.get(request)
    if (!owner) return false // Only classify errors from an admitted upstream path.
    return this.record(error, {
      ...owner,
      phase: 'proxy',
      request,
      authorityOnly: request.method === 'CONNECT'
    })
  }

  record (error, { run, target, phase, primary = false, request = error, authorityOnly = false }) {
    const original = tlsValidationError(error)
    if (!original) return false
    if (this.#seen.has(request)) return true
    this.#seen.add(request)
    const url = new URL(destinations.get(error) || target)
    url.username = ''; url.password = ''
    const scope = run && this.#runs.get(run)
    const owned = scope?.open === true
    this.#entries.push({
      kind: 'tls_validation_failed',
      code: original.code,
      message: original.message,
      phase,
      url: authorityOnly ? null : url.href,
      hostname: hostname(url),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      pageId: owned ? scope.pageId : null
    })
    if (owned) {
      scope.partial = true
      if (primary) scope.error ||= original
    }
    return true
  }
}
