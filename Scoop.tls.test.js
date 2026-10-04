import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('upstream TLS validation through real sockets, Chromium, CLI and archives', { timeout: 240000 }, async t => {
  // Node reads extra authorities at startup; never change the parent trust store.
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('./utils/fixtures/upstream-tls/ca.pem', import.meta.url)) }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TLS_REJECT_UNAUTHORIZED
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--test', fileURLToPath(new URL('./utils/fixtures/upstream-tls/cases.mjs', import.meta.url))
    ], { env, timeout: 230000, maxBuffer: 4 * 1024 * 1024 })
    t.diagnostic(stdout)
  } catch (error) {
    assert.fail((error.stdout || '') + (error.stderr || '') + error.message)
  }
})
