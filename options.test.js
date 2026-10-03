import test from 'node:test'
import assert from 'node:assert/strict'

import * as CONSTANTS from './constants.js'
import { defaults, filterOptions } from './options.js'

test('filterOptions invalid or empty argument should return full defaults.', async (_t) => {
  for (const input of [{}, [], null, undefined, true, 'FOO', () => {}]) {
    const options = filterOptions(input)

    assert(options !== defaults)
    assert(Object.keys(options).length === Object.keys(defaults).length)

    for (const key of Object.keys(options)) {
      assert(options[key] === defaults[key])
    }
  }
})

test('filterOptions entries that are not provided should be filled with defaults.', async (_t) => {
  const newOptions = { logLevel: 'trace', screenshot: false, captureWindowX: 1920, captureWindowY: 1080 }

  for (const [key, value] of Object.entries(filterOptions(newOptions))) {
    // Modified
    if (key in newOptions) {
      assert(value === newOptions[key])
    // Default
    } else {
      assert(value === defaults[key])
    }
  }
})

test('filterOptions entries are typecast based on defaults.', async (_t) => {
  const newOptions = filterOptions({
    screenshot: 0,
    captureWindowX: '1920',
    captureWindowY: '1080',
    intercepter: 12
  })

  for (const key of Object.keys(newOptions)) {
    assert(newOptions[key].constructor === defaults[key].constructor)
  }
})

test('filterOptions ytDlpPath must be a valid path to a file.', async (_t) => {
  assert.doesNotThrow(() => filterOptions()) // Default should not throw

  for (const ytDlpPath of [null, false, true, 12, () => {}, 'FOO', CONSTANTS.TMP_PATH]) {
    assert.throws(() => filterOptions({ ytDlpPath }))
  }
})

test('Chromium sandboxing defaults to enabled and accepts an explicit operator choice', () => {
  assert.equal(filterOptions().chromiumSandbox, true)
  assert.equal(filterOptions({ chromiumSandbox: true }).chromiumSandbox, true)
  assert.equal(filterOptions({ chromiumSandbox: false }).chromiumSandbox, false)
})

test('locale accepts and canonicalizes one primitive language tag, or keeps defaults', () => {
  const paths = { ytDlpPath: process.execPath, cripPath: process.execPath }
  assert.equal(filterOptions(paths).locale, '')
  for (const [locale, expected] of [[undefined, ''], ['', ''], ['es', 'es'], ['es-es', 'es-ES'], ['en-gb', 'en-GB'], ['zz-ZZ', 'zz-ZZ'], ['false', 'false']]) {
    assert.equal(filterOptions({ ...paths, locale }).locale, expected)
  }
})

test('locale rejects coercible non-strings, malformed tags and header syntax before casting', () => {
  const paths = { ytDlpPath: process.execPath, cripPath: process.execPath }
  for (const locale of [null, true, false, 0, 1, [], ['es-ES'], {}, new String('es'), () => 'es', ' ', '\t', ' es', 'es ', 'not_a_locale', 'es,en', 'es;q=0.8', 'es\r\nX: y', 'es\n', 'es\0']) { // eslint-disable-line no-new-wrappers
    assert.throws(() => filterOptions({ ...paths, locale }), /locale.*primitive string.*single language tag/)
  }
})
