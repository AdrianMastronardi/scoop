import crypto from 'crypto'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

import { BaseSerializerBuffer, WARCRecord, WARCSerializer } from 'warcio'

import { payloadDeduplicator } from './payload-deduplication.js'
import { destinationPath, publishFile, writeChunks } from './file-output.js'
import { multipageState, validateInventory, validateSource } from '../utils/multipage.js'

import * as CONSTANTS from '../constants.js'
import { Scoop } from '../Scoop.js'
import { ScoopGeneratedExchange } from '../exchanges/index.js'

// warcio needs the crypto utils suite as a global, but does not import it.
// Node JS 19+ automatically imports webcrypto as globalThis.crypto.
if (!globalThis.crypto) {
  globalThis.crypto = crypto
}

/**
 * Upper bound, in bytes, of each view cut from a body to serialize it.
 * @constant
 */
const BODY_VIEW_SIZE = 1024 * 1024

/**
 * Upper bound, in bytes, of each chunk of compressed output.
 * @constant
 */
const GZIP_CHUNK_SIZE = 16 * 1024

/**
 * Scoop capture to WARC converter.
 *
 * Returns the whole WARC, so needs memory in proportion to it.
 * `scoopToWARCFile` writes it to a file instead.
 *
 * Note:
 * - Logs are added to capture object via `Scoop.log`.
 *
 * @param {Scoop} capture
 * @param {boolean} [gzip=false]
 * @returns {Promise<ArrayBuffer|Uint8Array>}
 */
export async function scoopToWARC (capture, gzip = false) {
  return (await serializeWARC(capture, gzip)).data
}

/** Serialize and retain the successful response map for WACZ entry validation. */
export async function serializeWARC (capture, gzip = false) {
  const records = new Map()
  const chunks = []
  let totalByteLength = 0

  gzip = Boolean(gzip)

  for await (const chunk of scoopToWARCChunks(capture, gzip, records)) {
    // A compressed chunk is a view of its compressor's output buffer: keep its
    // bytes, not that buffer. Other chunks are views of what the capture retains.
    chunks.push(gzip ? Buffer.from(chunk) : chunk)
    totalByteLength += chunk.length
  }

  //
  // Combine output and return as Uint8Array
  //
  const warc = new Uint8Array(totalByteLength)

  let offset = 0
  for (const chunk of chunks) {
    warc.set(chunk, offset)
    offset += chunk.length
  }

  return { data: warc, records }
}

/**
 * Scoop capture to WARC file converter.
 *
 * Writes the WARC as it is serialized, so that the memory needed on top of the
 * capture does not grow with the WARC: see `scoopToWARCChunks`.
 *
 * The file is written in a private directory beside `path` and only takes that
 * name once complete and closed. An existing `path`, including a symbolic link,
 * is left as it is, and the export fails with `EEXIST`.
 *
 * Note:
 * - Logs are added to capture object via `Scoop.log`.
 * - The capture must not be modified during the export.
 *
 * @param {Scoop} capture
 * @param {string} path - Where to write the WARC. Its directory must exist, on a filesystem with hard links.
 * @param {boolean} [gzip=false]
 * @returns {Promise<void>}
 */
export async function scoopToWARCFile (capture, path, gzip = false) {
  assertExportable(capture)
  const destination = destinationPath(path)
  const chunks = scoopToWARCChunks(capture, gzip)

  await publishFile(destination, capture.log, async (directory) => {
    const warcPath = join(directory, 'archive.warc')
    await writeChunks(chunks, warcPath)
    return warcPath
  })
}

/**
 * Serializes a Scoop capture to WARC, one chunk at a time.
 *
 * Nothing is accumulated: bodies are read as views of what the exchanges
 * retain, and a record is compressed as it is consumed. A chunk is only
 * produced when the consumer asks for the next one, which is how a slow
 * destination holds the serialization back.
 *
 * Throws, before reading any exchange, if the capture cannot be exported.
 *
 * @param {Scoop} capture
 * @param {boolean} [gzip=false] - If `true`, each record is its own gzip member.
 * @param {Map<string, WARCRecord>} [records] - Receives the response record of each exchange, by exchange id.
 * @returns {AsyncGenerator<Uint8Array>}
 */
export function scoopToWARCChunks (capture, gzip = false, records = new Map()) {
  assertExportable(capture)

  const inventory = multipageState(capture)
  if (inventory) validateInventory(inventory.data, capture.exchanges, capture.state === Scoop.states.RECONSTRUCTED ? undefined : capture.steps)
  const dedup = capture.options.deduplicatePayloads ? payloadDeduplicator(capture.exchanges) : null

  return serializeRecords(capture, Boolean(gzip), records, inventory, dedup)
}

/**
 * @param {any} capture
 * @throws If `capture` is not a Scoop capture in a state that can be exported to WARC.
 */
function assertExportable (capture) {
  const validStates = [
    Scoop.states.PARTIAL,
    Scoop.states.COMPLETE,
    Scoop.states.RECONSTRUCTED
  ]

  // Check capture state
  if (!(capture instanceof Scoop) || !validStates.includes(capture.state)) {
    throw new Error('"capture" must be a partial or complete Scoop capture object.')
  }
}

/**
 * @param {Scoop} capture
 * @param {boolean} gzip
 * @param {Map<string, WARCRecord>} records
 * @param {?object} inventory - Validated multipage state, if any.
 * @param {?object} dedup - Payload deduplicator, if requested.
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function * serializeRecords (capture, gzip, records, inventory, dedup) {
  //
  // Prepare WARC info section
  //
  const info = WARCRecord.createWARCInfo(
    { filename: 'archive.warc', warcVersion: `WARC/${CONSTANTS.WARC_VERSION}` },
    { software: `${CONSTANTS.SOFTWARE} ${CONSTANTS.VERSION}` }
  )
  yield * serializedRecord(new WARCSerializer(info), gzip)

  //
  // Prepare WARC records section
  //
  for (const exchange of capture.exchanges) {
    // Ignore loose requests
    if (!exchange.response) {
      continue
    }

    for (const type of ['request', 'response']) {
      const msg = exchange[type]
      // Ignore empty records
      if (!msg) {
        continue
      }

      let record = null
      let serializer = null
      let candidate = null

      try {
        candidate = type === 'response' ? dedup?.candidate(exchange) : null
        const source = candidate?.source
        const body = source ? Buffer.alloc(0) : msg.body

        const warcHeaders = {}

        // Pairs request / responses together so they can be reconstructed later.
        warcHeaders[CONSTANTS.EXCHANGE_ID_HEADER_LABEL] = exchange.id

        // Add `WARC-Refers-To-Target-URI` to associate generated exchanges with their origin.
        if (exchange instanceof ScoopGeneratedExchange) {
          validateSource(exchange, inventory?.data)
          if (inventory) {
            if (exchange.pageId) {
              warcHeaders['Scoop-Page-ID'] = exchange.pageId
              warcHeaders['Scoop-Source-URL'] = exchange.sourceUrl
            }
          } else warcHeaders['WARC-Refers-To-Target-URI'] = capture.url
        }

        if (exchange.description) {
          warcHeaders[CONSTANTS.EXCHANGE_DESCRIPTION_HEADER_LABEL] = exchange.description
        }

        if (source) {
          Object.assign(warcHeaders, {
            'WARC-Profile': 'http://netpreserve.org/warc/1.1/revisit/identical-payload-digest',
            'WARC-Payload-Digest': candidate.hash,
            'WARC-Refers-To': source.id,
            'WARC-Refers-To-Target-URI': source.url,
            'WARC-Refers-To-Date': source.date,
            'WARC-Truncated': 'length'
          })
        }
        const rawHeaders = (inventory || dedup) && exchange[`${type}Parsed`]?.rawHeaders
        const httpHeaders = rawHeaders
          ? Array.from({ length: rawHeaders.length / 2 }, (_, i) => [rawHeaders[i * 2], rawHeaders[i * 2 + 1]])
          : Object.fromEntries(msg.headers.entries())
        record = WARCRecord.create(
          {
            url: exchange.url,
            date: exchange.date.toISOString(),
            type: source ? 'revisit' : type,
            warcVersion: `WARC/${CONSTANTS.WARC_VERSION}`,
            statusline: msg.startLine,
            httpHeaders,
            warcHeaders
          },
          bodyViews(body)
        )

        // Reads the body once, for the digests and length that go in the record's
        // headers. Whatever makes a record impossible to serialize is found here,
        // before any of its bytes are produced.
        serializer = new WARCSerializer(record, {}, new RetainedBody(body))
        await serializer.digestRecord()
      } catch (err) {
        if (inventory || dedup) throw err
        capture.log.warn(`${msg.url} ${type} could not be added to warc.`)
        capture.log.trace(err)
        continue
      }

      // Past this point part of the record may be in the output: there is no
      // leaving the rest out, and a failure is a failure of the whole export.
      yield * serializedRecord(serializer, gzip)

      if (type === 'response') {
        records.set(exchange.id, record)
        dedup?.register(candidate, exchange, record)
      }
    }
  }

  if (inventory) {
    for (const page of inventory.data.pages) {
      if (!page.entryPoint) continue
      const chain = inventory.chains.get(page.id)
      if (chain && (!chain.length || chain.some(id => !records.has(id)))) throw new Error(`Missing serialized navigation chain for ${page.id}`)
    }
  }
}

/**
 * Views of a body, each at most `BODY_VIEW_SIZE` long. No byte is copied.
 *
 * @param {Uint8Array} body
 * @returns {Generator<Uint8Array>}
 */
function * bodyViews (body) {
  for (let offset = 0; offset < body.length; offset += BODY_VIEW_SIZE) {
    yield body.subarray(offset, offset + BODY_VIEW_SIZE)
  }
}

/**
 * Stands in for the buffer in which warcio's serializer keeps a record's body
 * between reading it, to compute its digests and length, and writing it after
 * its headers. The exchange already retains that body: this keeps no chunk,
 * and replays views of it.
 */
class RetainedBody extends BaseSerializerBuffer {
  /** @param {Uint8Array} body */
  constructor (body) {
    super()
    this.body = body
  }

  write () {}

  async * readAll () {
    yield * bodyViews(this.body)
  }

  purge () {}
}

/**
 * The bytes of one record.
 *
 * @param {WARCSerializer} serializer - Created without its own compression.
 * @param {boolean} gzip
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function * serializedRecord (serializer, gzip) {
  if (!gzip) {
    yield * serializer
    return
  }

  // A gzip member per record: what lets an index address a record by its offset.
  const compressor = createGzip({ chunkSize: GZIP_CHUNK_SIZE })

  // Feeds the compressor as it drains. Settles when it has taken the whole
  // record, or when either side fails or the consumer stops asking.
  const fed = pipeline(serializer, compressor).catch(() => {})

  try {
    yield * compressor
  } finally {
    compressor.destroy()
    await fed
  }
}
