import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import * as CONSTANTS from '../constants.js'

const MEASURE_FIXTURE = join(CONSTANTS.BASE_PATH, 'utils', 'fixtures', 'export', 'measure.mjs')
const MiB = 1024 * 1024

test('Exporting to a WACZ file takes no more memory for 192 MiB of bodies than for 16 MiB.', { timeout: 600000 }, async (t) => {
  // In Scoop's own scratch directory: the system's is memory on some machines.
  await mkdir(CONSTANTS.TMP_PATH, { recursive: true })
  const directory = await mkdtemp(join(CONSTANTS.TMP_PATH, 'export-memory-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  // With --expose-gc the fixture collects garbage as it samples. Left to itself
  // the runtime frees written chunks tens of MiB at a time, when it sees fit:
  // from one run to the next that moves the peak by more than this test allows,
  // and says nothing of what the export holds on to.
  const measure = async (total) => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', MEASURE_FIXTURE, String(total), directory])
    return JSON.parse(stdout)
  }

  // The same records, headers and attachments, a third of the bytes in one
  // response: 64 MiB of the larger capture. What exporting costs on top of the
  // capture is measured in a new process each time, three times per size, as
  // allocators do not repeat themselves.
  const highest = {}
  for (const total of [16, 192]) {
    const runs = await Promise.all([measure(total), measure(total), measure(total)])

    for (const run of runs) {
      t.diagnostic(JSON.stringify(run))
      assert.ok(run.valid, 'the archive holds every body and matches its own digests')
      assert.equal(run.workers, 1)
      assert.ok(run.oomKills === null || run.oomKills === 0)
    }
    assert.ok(runs.every(run => run.warcBytes > total * MiB))

    highest[total] = Math.max(...runs.map(run => run.rssIncrease))
  }

  const difference = highest[192] - highest[16]
  t.diagnostic(`Highest increase of RSS: ${(highest[16] / MiB).toFixed(1)} MiB for 16 MiB, ${(highest[192] / MiB).toFixed(1)} MiB for 192 MiB`)
  assert.ok(difference <= 48 * MiB, `exporting 192 MiB took ${(difference / MiB).toFixed(1)} MiB more than exporting 16 MiB`)

  // Six archives, and nothing else left of the exports.
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.wacz')).length, 6)
  assert.equal((await readdir(directory)).length, 6)
})
