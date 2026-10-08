import fs from 'fs/promises'
import { multipageSnapshot } from '../utils/multipage.js'
import { createReadStream } from 'fs'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { sep } from 'path'

import { WACZ } from '@harvard-lil/js-wacz'
import { WARCParser } from 'warcio'

import { Scoop } from '../Scoop.js'
import * as CONSTANTS from '../constants.js'
import { getHead } from '../utils/http.js'
import { formatErrorMessage } from '../utils/formatErrorMessage.js'
import { ScoopGeneratedExchange } from '../exchanges/ScoopGeneratedExchange.js'
import { ScoopExchange } from '../exchanges/ScoopExchange.js' // eslint-disable-line
import { rawResourceName } from './rawResourceName.js'
import { destinationPath, publishFile } from './file-output.js'

// The worker pool is a dependency of the WACZ generator, not of Scoop: take the
// class the generator itself would use, wherever its dependencies are installed.
const { Piscina } = createRequire(import.meta.resolve('@harvard-lil/js-wacz'))('piscina')

/**
 * Scoop capture to WACZ converter.
 *
 * Returns the whole WACZ, and builds it from the whole WARC, so needs memory
 * in proportion to them. `scoopToWACZFile` writes it to a file instead.
 *
 * Note:
 * - Logs are added to capture object via `Scoop.log`.
 *
 * @param {Scoop} capture
 * @param {boolean} [includeRaw=false] - If `true`, includes the raw http exchanges in the WACZ.
 * @param {object} signingServer - Optional server information for signing the WACZ
 * @param {string} signingServer.url - url of the signing server
 * @param {string} signingServer.token - Optional token to be passed to the signing server via the Authorization header
 * @returns {Promise<ArrayBuffer>}
 */
export async function scoopToWACZ (capture, includeRaw = false, signingServer) {
  assertExportable(capture)

  /** @type {?string} */
  let outputDir = null

  /** @type {?Buffer} */
  let waczData = null

  //
  // Create a temporary directory
  //
  try {
    outputDir = await fs.mkdtemp(CONSTANTS.TMP_PATH)
  } catch (err) {
    capture.log.trace(err)
    throw new Error(`scoopToWACZ was unable to create a temporary directory at ${outputDir}.`)
  }

  try {
    const waczPath = await buildWACZ(capture, outputDir, includeRaw, signingServer, async (warcPath) => {
      const warc = await capture.toWARC(true)
      await fs.writeFile(warcPath, Buffer.from(warc))
    })

    try {
      waczData = await fs.readFile(waczPath)
    } catch (err) {
      capture.log.trace(err)
      throw exportError('An error occurred while processing WACZ file', err)
    }
  } finally {
    try {
      await fs.rm(outputDir, { recursive: true, force: true })
    } catch (err) {
      capture.log.warn(`Temporary folder could not be cleared (${outputDir}.`)
    }
  }

  return waczData.buffer
}

/**
 * Scoop capture to WACZ file converter.
 *
 * Builds the WACZ from a WARC on disk and never holds either in memory, so
 * that the memory needed on top of the capture does not grow with them.
 *
 * The WARC, the generator's own intermediates and the WACZ are written in a
 * private directory beside `path`, which only takes that name once the WACZ is
 * complete and closed. An existing `path`, including a symbolic link, is left
 * as it is, and the export fails with `EEXIST`. The directory is removed
 * whether the export succeeds or fails; if that fails, a warning says where it is.
 *
 * The WARC is written by `capture.toWARCFile(path, true)`. A subclass of Scoop
 * may override that method to keep a copy of the complete WARC, outside of the
 * directory it is given, before the WACZ is built: see `Scoop.toWARCFile`.
 *
 * A rejection carries the `code` of the error that caused it, if it had one
 * (`ENOSPC`, `EEXIST`...), and that error as its `cause`.
 *
 * Note:
 * - Logs are added to capture object via `Scoop.log`.
 * - The capture must not be modified during the export.
 *
 * @param {Scoop} capture
 * @param {string} path - Where to write the WACZ. Its directory must exist, on a filesystem with hard links.
 * @param {boolean} [includeRaw=false] - If `true`, includes the raw http exchanges in the WACZ.
 * @param {object} signingServer - Optional server information for signing the WACZ
 * @param {string} signingServer.url - url of the signing server
 * @param {string} signingServer.token - Optional token to be passed to the signing server via the Authorization header
 * @returns {Promise<void>}
 */
export async function scoopToWACZFile (capture, path, includeRaw = false, signingServer) {
  assertExportable(capture)
  const destination = destinationPath(path)

  await publishFile(destination, capture.log, async (directory) => {
    return await buildWACZ(capture, directory, includeRaw, signingServer, async (warcPath) => {
      await capture.toWARCFile(warcPath, true)
    })
  })
}

/**
 * @param {any} capture
 * @throws If `capture` is not a Scoop capture in a state that can be exported to WACZ.
 */
function assertExportable (capture) {
  if (capture instanceof Scoop === false ||
      [Scoop.states.PARTIAL, Scoop.states.COMPLETE].includes(capture.state) === false) {
    throw new Error('`capture` must be a partial or complete Scoop object.')
  }
}

/**
 * An error naming the step of the export that failed.
 * Keeps the error that caused it as `cause`, and the first `code` found down
 * the chain of causes, so that a caller can tell an `ENOSPC` from an `EEXIST`
 * without reading messages.
 *
 * @param {string} step
 * @param {Error} cause
 * @returns {Error}
 */
function exportError (step, cause) {
  const error = new Error(`${step} (${formatErrorMessage(cause)}).`, { cause })

  for (let current = cause; current instanceof Error; current = current.cause) {
    if (current.code !== undefined) {
      error.code = current.code
      break
    }
  }

  return error
}

/**
 * A pool of exactly one worker for the WACZ generator to index with.
 *
 * Left to itself the generator sizes its pool by the processors it sees, and
 * starts half of those workers at once. Scoop gives it a single WARC, which a
 * single worker reads: the others would only take memory, all the more of it
 * where a container sees every processor of its host.
 *
 * The worker runs Scoop's `indexWARC.js` rather than the generator's own,
 * which reads each record whole into memory. Its space for new objects is kept
 * small, so that it frees what it has read as it goes: left to its default, it
 * puts that off for tens of MiB at a time.
 *
 * @returns {Piscina}
 */
function singleWorkerIndexingPool () {
  return new Piscina({
    filename: new URL('./indexWARC.js', import.meta.url).href,
    minThreads: 1,
    maxThreads: 1,
    resourceLimits: { maxYoungGenerationSizeMb: 4 }
  })
}

/**
 * Builds a WACZ file for a capture in `outputDir`, along with its intermediates.
 * The caller owns `outputDir`, and removes it.
 *
 * @param {Scoop} capture
 * @param {string} outputDir - An existing directory to build in.
 * @param {boolean} includeRaw
 * @param {?{url: string, token: ?string}} signingServer
 * @param {function(string): Promise<void>} writeWARC - Writes the capture's gzipped WARC at the given path.
 * @returns {Promise<string>} Path of the WACZ, in `outputDir`.
 */
async function buildWACZ (capture, outputDir, includeRaw, signingServer, writeWARC) {
  const inventory = multipageSnapshot(capture)
  const firstPage = inventory?.pages.find(page => page.entryPoint)

  const warcPath = `${outputDir}${sep}data.warc.gz`
  const waczPath = `${outputDir}${sep}data.wacz`

  /** @type {?WACZ} */
  let transformer = null

  /** @type {ScoopExchange} */
  let firstExchange = null

  // Grab first exchange for future reference
  if (capture.exchanges) {
    firstExchange = capture.exchanges[0]
  }

  /**
   * Closure to be called on error: stops the generator's workers, signature request and output streams
   * before the caller removes the directory they work in, and makes the error to throw.
   * @param {string} step
   * @param {Error} err
   * @returns {Promise<Error>}
   */
  async function failed (step, err) {
    capture.log.trace(err)

    try {
      await transformer?.dispose()
    } catch (disposalError) {
      capture.log.trace(disposalError)
    }

    return exportError(step, err)
  }

  //
  // Generate and write WARC to disk
  //
  try {
    await writeWARC(warcPath)
  } catch (err) {
    throw await failed('An error occurred while creating underlying WARC file', err)
  }

  //
  // Open new WACZ instance
  //
  try {
    transformer = new WACZ({
      input: warcPath,
      output: waczPath,
      detectPages: false,
      log: capture.log,
      // Capture info
      url: inventory ? firstPage?.entryPoint.url : capture.url,
      ts: inventory ? firstPage?.entryPoint.ts : capture.startedAt,
      title: capture.pageInfo?.title
        ? capture.pageInfo.title
        : capture.url,
      description: capture.pageInfo?.description
        ? capture.pageInfo.description
        : `Captured by Scoop on ${capture.startedAt.toISOString()}`,
      // Optional: signing url / token, capture state, provenance info
      signingUrl: signingServer?.url,
      signingToken: signingServer?.token,
      datapackageExtras: {
        ...(inventory ? { multipage: inventory } : {}),
        state: capture.state,
        captureErrors: capture.errors,
        states: Object.keys(Scoop.states),
        provenanceInfo: capture.options.provenanceSummary ? capture.provenanceInfo : null
      }
    })
    // js-wacz defaults ts to now even when the option is omitted. No recorded
    // target means neither replay-start hint may be advertised.
    if (inventory && !firstPage) transformer.ts = null
  } catch (err) {
    throw await failed('An error occurred while initializing WACZ output', err)
  }

  //
  // Add entries to pages.jsonl
  //
  try {
    // First page
    if (inventory) {
      for (const page of inventory.pages) {
        if (page.entryPoint) transformer.addPage(page.entryPoint.url, page.pageInfo.title || page.requestedUrl, page.entryPoint.ts)
      }
    } else if (firstExchange) {
      transformer.addPage(
        firstExchange.url,
        `High-Fidelity Web Capture of ${firstExchange.url}`,
        firstExchange.date.toISOString()
      )
    }

    // Generated exchanges
    for (const exchange of capture.exchanges) {
      if (exchange instanceof ScoopGeneratedExchange === false) {
        continue
      }

      if (!exchange.isEntryPoint) {
        continue
      }

      transformer.addPage(exchange.url, exchange.description, exchange.date.toISOString())
    }
  } catch (err) {
    throw await failed('An error occurred while adding pages to WACZ output', err)
  }

  //
  // Append RAW exchanges if requested
  //
  if (includeRaw) {
    const stream = createReadStream(warcPath)

    try {
      const parser = new WARCParser(stream)
      const warcPayloadDigests = []

      // Compiles a list of payload digests to match against below
      for await (const record of parser) {
        const digest = record.warcHeader('WARC-Payload-Digest')
        if (digest) {
          warcPayloadDigests.push(digest)
        }
      }

      // For each exchange: determine if payload is already present _as is_ in WARC.
      // If so, only store raw headers in separate files.
      for (const exchange of capture.exchanges) {
        for (const type of ['request', 'response']) {
          const data = exchange[`${type}Raw`]
          if (!data?.length) {
            continue
          }

          const dataHash = await transformer.sha256(data)
          const destination = rawResourceName(type, exchange.date, exchange.id)

          if (!inventory && !capture.options.deduplicatePayloads && warcPayloadDigests.includes(dataHash)) {
            await transformer.addFileToZip(getHead(data), destination) // Add only the head and trailing CRLF
          } else {
            await transformer.addFileToZip(data, destination)
          }
        }
      }
    } catch (err) {
      throw await failed('An error occurred while adding raw exchanges to WACZ output', err)
    } finally {
      stream.destroy()
      if (!stream.closed) await once(stream, 'close')
    }
  }

  //
  // Process WACZ file
  //
  try {
    transformer.indexWARCPool = singleWorkerIndexingPool()
    await transformer.process(true)
  } catch (err) {
    throw await failed('An error occurred while processing WACZ file', err)
  }

  return waczPath
}
