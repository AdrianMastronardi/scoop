// Exports the memory reference capture to a file where the export is expected
// to fail, and prints, as JSON, what its caller sees and what is left behind.
// Ends when nothing keeps the process alive: it never calls process.exit().
//
//   node utils/fixtures/export/fail.mjs <warc|wacz> <total MiB of bodies> <destination>
import { readdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { MiB, referenceExchanges, syntheticCapture } from './capture.mjs'

const [format, total, destination] = process.argv.slice(2)
const capture = syntheticCapture(referenceExchanges(Number(total) * MiB))
const outcome = {}

try {
  if (format === 'warc') {
    await capture.toWARCFile(destination, true)
  } else {
    await capture.toWACZFile(destination)
  }
  outcome.published = true
} catch (error) {
  outcome.published = false
  outcome.code = error.code
  outcome.message = error.message
  outcome.causes = []
  for (let cause = error.cause; cause instanceof Error; cause = cause.cause) {
    outcome.causes.push({ code: cause.code, syscall: cause.syscall })
  }
}

outcome.entries = await readdir(dirname(destination))
console.log(JSON.stringify(outcome))
