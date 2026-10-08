// Exports the memory reference capture to WACZ and prints, as JSON, what the
// export cost and whether the archive holds what the capture did.
//
// Run in a new process for each measurement, from the repository root:
//   node [--expose-gc] utils/fixtures/export/measure.mjs <total MiB of bodies> <existing directory>
//
// The runtime frees a chunk it has written when it next collects garbage, which
// it puts off for as long as tens of MiB at a time. With --expose-gc, garbage is
// collected every few milliseconds, so that the peak counts what the export
// holds on to rather than what the runtime has not yet got around to freeing.
// Only in this thread: the indexing worker is left to itself either way.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import StreamZip from 'node-stream-zip'
import { WARCParser } from 'warcio'

import { MiB, referenceExchanges, sha256, syntheticCapture } from './capture.mjs'

const [total, directory] = [Number(process.argv[2]), process.argv[3]]
const destination = join(directory, `reference-${total}-${process.pid}.wacz`)

/** The installed version of a dependency, whether or not it exports its manifest. */
function version (name) {
  for (let directory = dirname(fileURLToPath(import.meta.resolve(name))); directory !== dirname(directory); directory = dirname(directory)) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (manifest.name === name) return manifest.version
    } catch {}
  }
  return null
}

/** A field of /proc/self/status in bytes, or null where there is no such file. */
function status (field) {
  try {
    return Number(readFileSync('/proc/self/status', 'utf8').match(new RegExp(`${field}:\\s+(\\d+) kB`))[1]) * 1024
  } catch {
    return null
  }
}

/** A file of this process's cgroup, or null outside of cgroup v2. */
function cgroup (file) {
  try {
    const path = readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(.*)$/m)[1]
    return readFileSync(join('/sys/fs/cgroup', path, file), 'utf8').trim()
  } catch {
    return null
  }
}

// The bodies exist before the measurement and are retained until it ends.
const exchanges = referenceExchanges(total * MiB)
const capture = syntheticCapture(exchanges)

let workers = 0
process.on('worker', () => workers++)

// Where the kernel keeps the peak, start it from here: it then misses nothing.
// Elsewhere the peak is the highest of the samples below.
try { writeFileSync('/proc/self/clear_refs', '5') } catch {}
const rssBefore = status('VmRSS') ?? process.memoryUsage.rss()
const oomKillsBefore = cgroup('memory.events')?.match(/^oom_kill (\d+)$/m)?.[1]
let sampledPeak = rssBefore
let samples = 0
const sampler = setInterval(() => {
  // Young objects every time, which is quick; everything every quarter of a second.
  globalThis.gc?.({ type: ++samples % 50 ? 'minor' : 'major' })
  sampledPeak = Math.max(sampledPeak, process.memoryUsage.rss())
}, 5)

const startedAt = performance.now()
await capture.toWACZFile(destination)
const durationMs = Math.round(performance.now() - startedAt)

clearInterval(sampler)
const rssPeak = status('VmHWM') ?? Math.max(sampledPeak, process.memoryUsage.rss())
const cgroupPeak = cgroup('memory.peak')
const oomKillsAfter = cgroup('memory.events')?.match(/^oom_kill (\d+)$/m)?.[1]

//
// Read the archive back, a chunk at a time, against the bodies still in memory.
//
const zip = new StreamZip.async({ file: destination }) // eslint-disable-line new-cap
const entries = await zip.entries()
const digest = async name => {
  const hash = createHash('sha256')
  for await (const chunk of await zip.stream(name)) hash.update(chunk)
  return 'sha256:' + hash.digest('hex')
}

const datapackage = JSON.parse(await zip.entryData('datapackage.json'))
const resourcesMatch = (await Promise.all(datapackage.resources.map(async resource =>
  entries[resource.path]?.size === resource.bytes && await digest(resource.path) === resource.hash))).every(Boolean)
const digestMatches = JSON.parse(await zip.entryData('datapackage-digest.json')).hash === await digest('datapackage.json')

const payloads = new Map()
for await (const record of new WARCParser(await zip.stream('archive/data.warc.gz'))) {
  if (record.warcType !== 'response') continue
  const hash = createHash('sha256')
  for await (const chunk of record.reader) hash.update(chunk)
  payloads.set(record.warcHeader('Scoop-Exchange-ID'), 'sha256:' + hash.digest('hex'))
}
const bodiesMatch = exchanges.every(exchange => payloads.get(exchange.id) === sha256(exchange.response.body))

const raw = (await Promise.all(exchanges.filter(exchange => exchange.responseRaw).map(async exchange => {
  const name = Object.keys(entries).find(name => name.startsWith('raw/response_') && name.endsWith(exchange.id))
  return name && await digest(name) === sha256(exchange.responseRaw)
}))).every(Boolean)

const warcBytes = entries['archive/data.warc.gz'].size
await zip.close()

console.log(JSON.stringify({
  totalMiB: total,
  records: exchanges.length,
  rssBefore,
  rssPeak,
  rssIncrease: rssPeak - rssBefore,
  peakSource: status('VmHWM') === null ? 'samples' : 'VmHWM',
  collection: globalThis.gc ? 'every 5 ms' : 'left to the runtime',
  cgroupPeak: cgroupPeak === null ? null : Number(cgroupPeak),
  oomKills: oomKillsAfter === undefined ? null : Number(oomKillsAfter) - Number(oomKillsBefore),
  warcBytes,
  waczBytes: (await stat(destination)).size,
  durationMs,
  workers,
  valid: resourcesMatch && digestMatches && bodiesMatch && raw,
  node: process.version,
  v8: process.versions.v8,
  warcio: version('warcio'),
  jsWacz: version('@harvard-lil/js-wacz'),
  availableParallelism: availableParallelism(),
  cpus: cpus().length,
  cpuModel: cpus()[0]?.model,
  totalMemory: totalmem(),
  cpuMax: cgroup('cpu.max'),
  memoryMax: cgroup('memory.max'),
  swapMax: cgroup('memory.swap.max')
}))
