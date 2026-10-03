import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Scoop } from '../Scoop.js'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js')

await test('CLI writes the JSON summary of a failed capture', async (_t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'scoop-cli-'))
  const summaryPath = path.join(dir, 'summary.json')

  try {
    const exitCode = await new Promise(resolve => {
      execFile('node', [
        // Chromium refuses port 9 (discard) outright, so navigation fails
        // whatever is listening there. A merely closed port would not do:
        // Chromium renders its own error page, and the capture completes.
        CLI, 'http://127.0.0.1:9/',
        '--output', path.join(dir, 'archive.wacz'),
        '--json-summary-output', summaryPath,
        '--blocklist', '',
        // Test files run in parallel; the default proxy port may be taken.
        '--proxy-port', String(Math.floor(5000 + Math.random() * 5000)),
        '--headless', 'true',
        '--log-level', 'silent',
        '--capture-video-as-attachment', 'false',
        '--capture-certificates-as-attachment', 'false',
        '--load-timeout', '2000'
      ], (err) => resolve(err ? err.code : 0))
    })

    assert.equal(exitCode, 1)
    const summary = JSON.parse(await readFile(summaryPath, 'utf-8'))
    assert.equal(summary.state, Scoop.states.FAILED)
    assert.equal(summary.states[summary.state], 'FAILED')
    assert(Array.isArray(summary.steps) && summary.steps.length > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function runCLI (args) {
  return new Promise(resolve => {
    execFile(process.execPath, args, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}

await test('CLI locale parsing, validation and browser rejection summaries', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'scoop-cli-locale-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const summaryPath = path.join(dir, 'summary.json')
  const inputPath = path.join(dir, 'input.json')
  const setupPath = path.join(dir, 'setup.json')
  const hookPath = path.join(dir, 'hook.mjs')
  const args = [
    '--import', pathToFileURL(hookPath).href, CLI, 'http://127.0.0.1/',
    '--output', path.join(dir, 'archive.wacz'),
    '--json-summary-output', summaryPath,
    '--blocklist', '', '--proxy-port', '0', '--log-level', 'error',
    '--screenshot', 'false',
    '--yt-dlp-path', process.execPath, '--crip-path', process.execPath
  ]
  async function hook (stage) {
    await writeFile(hookPath, `
      import { writeFile } from 'node:fs/promises'
      import { Scoop } from ${JSON.stringify(new URL('../Scoop.js', import.meta.url).href)}
      import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))}
      const capture = Scoop.capture.bind(Scoop)
      Scoop.capture = async (url, options) => {
        await writeFile(${JSON.stringify(inputPath)}, JSON.stringify(options))
        return capture(url, options)
      }
      chromium.launch = async () => ({
        newContext: async options => {
          await writeFile(${JSON.stringify(setupPath)}, JSON.stringify(options))
          if (${JSON.stringify(stage)} === 'context') throw new Error('Simulated Chromium context rejection')
          return { newPage: async () => { throw new Error('Simulated Chromium page rejection') } }
        },
        close: async () => {}
      })
    `)
  }
  const help = await runCLI([CLI, '--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /--locale <string>/)
  await hook('context')
  for (const locale of ['true', 'not_a_locale', 'es,en', 'es;q=0.8', ' ', ' es', 'es ', 'es\r\nX: y']) {
    const result = await runCLI([...args, '--locale', locale])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /locale.*primitive string/)
    const input = JSON.parse(await readFile(inputPath, 'utf8'))
    assert.equal(input.locale, locale)
    assert.equal(input.screenshot, false)
    await assert.rejects(readFile(summaryPath), { code: 'ENOENT' })
    await assert.rejects(readFile(setupPath), { code: 'ENOENT' })
  }
  await rm(inputPath)
  const missing = await runCLI([...args, '--locale'])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /--locale.*argument missing/)
  await assert.rejects(readFile(inputPath), { code: 'ENOENT' })
  for (const stage of ['context', 'page']) {
    await hook(stage)
    for (const locale of [undefined, '', 'es-es', 'en-GB', 'zz-ZZ', 'false']) {
      const canonical = locale ? Intl.getCanonicalLocales(locale)[0] : ''
      const result = await runCLI([...args, ...(locale === undefined ? [] : ['--locale', locale])])
      assert.equal(result.code, 1)
      assert.match(result.stderr, new RegExp(`Simulated Chromium ${stage} rejection`))
      if (locale) assert(result.stderr.includes(`locale="${canonical}"`))
      const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
      assert.equal(summary.state, Scoop.states.FAILED)
      assert.equal(summary.options.locale, canonical)
      assert.equal(summary.provenanceInfo.options, undefined)
      const context = JSON.parse(await readFile(setupPath, 'utf8'))
      assert.equal(context.locale, canonical || undefined)
    }
  }
})
