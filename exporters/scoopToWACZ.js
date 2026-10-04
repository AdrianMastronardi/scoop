import fs from 'fs/promises'
import { multipageSnapshot } from '../utils/multipage.js'
import { createReadStream } from 'fs'
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

/**
 * Scoop capture to WACZ converter.
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
  if (capture instanceof Scoop === false ||
      [Scoop.states.PARTIAL, Scoop.states.COMPLETE].includes(capture.state) === false) {
    throw new Error('`capture` must be a partial or complete Scoop object.')
  }

  const inventory = multipageSnapshot(capture)
  const firstPage = inventory?.pages.find(page => page.entryPoint)

  /** @type {?string} */
  let outputDir = null

  /** @type {?string} */
  let warcPath = null

  /** @type {?string} */
  let waczPath = null

  /** @type {?WACZ} */
  let transformer = null

  /** @type {?Buffer} */
  let waczData = null

  /** @type {ScoopExchange} */
  let firstExchange = null

  // Grab first exchange for future reference
  if (capture.exchanges) {
    firstExchange = capture.exchanges[0]
  }

  /**
   * Closure to be called on error or complete to dispose of temporary folder and associated files created for this WACZ.
   * @returns {Promise<void>}
   */
  async function clearOutputDir () {
    try {
      await fs.rm(outputDir, { recursive: true, force: true })
    } catch (err) {
      capture.log.warn(`Temporary folder could not be cleared (${outputDir}.`)
    }
  }

  //
  // Create a temporary directory
  //
  try {
    outputDir = await fs.mkdtemp(CONSTANTS.TMP_PATH)
    warcPath = `${outputDir}${sep}data.warc.gz`
    waczPath = `${outputDir}${sep}data.wacz`
  } catch (err) {
    capture.log.trace(err)
    throw new Error(`scoopToWACZ was unable to create a temporary directory at ${outputDir}.`)
  }

  //
  // Generate and write WARC to disk
  //
  try {
    const warc = await capture.toWARC(true)
    await fs.writeFile(warcPath, Buffer.from(warc))
  } catch (err) {
    capture.log.trace(err)
    await clearOutputDir()
    throw new Error(`An error occurred while creating underlying WARC file (${formatErrorMessage(err)}).`)
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
    capture.log.trace(err)
    await clearOutputDir()
    throw new Error(`An error occurred while initializing WACZ output (${formatErrorMessage(err)}).`)
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
    capture.log.trace(err)
    await clearOutputDir()
    throw new Error(`An error occurred while adding pages to WACZ output (${formatErrorMessage(err)}).`)
  }

  //
  // Append RAW exchanges if requested
  //
  if (includeRaw) {
    try {
      const stream = createReadStream(warcPath)
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
      capture.log.trace(err)
      await clearOutputDir()
      throw new Error(`An error occurred while adding raw exchanges to WACZ output (${formatErrorMessage(err)}).`)
    }
  }

  //
  // Process WACZ file
  //
  try {
    await transformer.process(true)
    waczData = await fs.readFile(waczPath)
  } catch (err) {
    capture.log.trace(err)
    await clearOutputDir()
    throw new Error(`An error occurred while processing WACZ file (${formatErrorMessage(err)}).`)
  }

  await clearOutputDir()
  return waczData.buffer
}
