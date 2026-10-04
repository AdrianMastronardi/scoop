import path from 'path'
import { restoreMultipage } from '../utils/multipage.js'
import { URL } from 'url'
import { createServer, request } from 'http'
import { Readable, PassThrough } from 'node:stream'

import { WARCParser } from 'warcio'
import StreamZip from 'node-stream-zip'

import { Scoop } from '../Scoop.js'
import { ScoopProxyExchange, ScoopGeneratedExchange } from '../exchanges/index.js'
import { EXCHANGE_ID_HEADER_LABEL, EXCHANGE_DESCRIPTION_HEADER_LABEL } from '../constants.js'
import { parseRawResourceDate } from '../exporters/rawResourceName.js'

const parsers = {
  request: (data) => new Promise(resolve =>
    createServer()
      .on('request', resolve)
      .on('connection', stream => stream.write(data))
      .emit('connection', new PassThrough())
  ),
  response: (data) => new Promise(resolve =>
    request({ createConnection: () => new PassThrough() })
      .on('socket', stream => stream.write(data))
      .on('response', resolve)
  )
}

/**
 * (Experimental) Reconstructs a Scoop capture from a WACZ containing raw http traffic data.
 * @param {string} zipPath - path to the zipped WACZ
 * @returns {Promise<Scoop>} a reconstructed Scoop capture object
 */
export async function WACZToScoop (zipPath) {
  const zip = new StreamZip.async({ file: zipPath }) // eslint-disable-line
  try {
    const datapackage = await getDataPackage(zip)
    const inventory = datapackage?.extras?.multipage
    const hasInventory = Object.hasOwn(datapackage.extras || {}, 'multipage')
    if (hasInventory && (!inventory || inventory.version !== 1 || !Array.isArray(inventory.urls) || !inventory.urls.length)) throw new Error('Unsupported or invalid multipage archive')
    // Archived options remain descriptive data, never runtime instructions.
    const capture = Scoop.fromArchive(hasInventory ? inventory.urls[0] : datapackage.mainPageUrl)
    Object.assign(capture, {
      startedAt: new Date(hasInventory ? inventory.startedAt : datapackage.mainPageDate),
      exchanges: await getExchanges(zip, hasInventory),
      state: Scoop.states.RECONSTRUCTED
    })
    if (hasInventory) {
      restoreMultipage(capture, inventory)
      capture.targetUrlResolved = inventory.pages[0].resolvedUrl || capture.url
      capture.pageInfo = structuredClone(inventory.pages[0].pageInfo)
      capture.steps = inventory.pages.flatMap(page => page.steps).sort((a, b) => Number(a.id.slice(5)) - Number(b.id.slice(5)))
    }
    if (datapackage?.extras?.provenanceInfo) capture.provenanceInfo = datapackage.extras.provenanceInfo
    return capture
  } finally {
    await zip.close()
  }
}

/**
 * Retrieves the datapackage.json data from the WARC and parses it
 *
 * @param {StreamZipAsync} zip
 * @returns {object} datapackage data
 * @private
 */
const getDataPackage = async (zip) => {
  return JSON.parse(await zip.entryData('datapackage.json'))
}

/**
 * Retrieves the raw requests and responses and initializes
 * them into ScoopProxyExchanges
 *
 * @param {StreamZipAsync} zip
 * @returns {ScoopProxyExchange[]} an array of reconstructed ScoopProxyExchanges
 * @private
 */
const getExchanges = async (zip, multipage = false) => {
  const exchanges = []
  const generatedExchanges = []

  const zipEntries = await zip.entries()
  const zipDirs = Object.keys(zipEntries).reduce((acc, name) => {
    const dir = path.dirname(name)
    acc[dir] ||= []
    acc[dir].push(name)
    return acc
  }, {})

  if (!zipDirs.raw) throw new Error('Reconstruction requires a WACZ with raw exchanges')
  const warcEntriesByDigest = {}
  const rawPayloadDigests = zipDirs.raw.map(name => path.basename(name).split('_')[3])
    .filter(digest => digest)

  for (const name of zipDirs.archive) {
    const zipData = await zip.entryData(name)
    const warc = new WARCParser(Readable.from(zipData))

    for await (const record of warc) {
      // Get data for rehydrating regular exchanges
      const digest = record.warcHeader('WARC-Payload-Digest')
      if (record.warcType === 'response' && rawPayloadDigests.includes(digest)) {
        warcEntriesByDigest[digest] = Buffer.from(await record.readFully(false))
      }

      // Get data for rehydrating generated exchanges
      const url = record.warcHeader('WARC-Target-URI')
      if (url && (new URL(url)).protocol === 'file:') {
        generatedExchanges.push(new ScoopGeneratedExchange({
          url,
          id: record.warcHeaders.headers.get(EXCHANGE_ID_HEADER_LABEL),
          date: new Date(record.warcHeaders.headers.get('WARC-Date')),
          description: record.warcHeaders.headers.get(EXCHANGE_DESCRIPTION_HEADER_LABEL),
          ...(multipage
            ? {
                pageId: record.warcHeader('Scoop-Page-ID') || undefined,
                sourceUrl: record.warcHeader('Scoop-Source-URL') || undefined
              }
            : {}),
          response: {
            startLine: record.httpHeaders.statusline,
            headers: new Headers(record.getResponseInfo().headers),
            body: Buffer.from(await record.readFully(false))
          }
        }))
      }
    }
  }

  let rawProps = await Promise.all(
    zipDirs.raw
      // get the data from the zip and shape it for exchange initialization
      .map(async (name) => {
        const [type, date, id, warcPayloadDigest] = path.basename(name).split('_')
        const buffers = [await zip.entryData(name)]
        // if the file name contains a warc payload digest and there's a matching
        // record from the warc file, append it to the headers
        if (warcEntriesByDigest[warcPayloadDigest]) {
          buffers.push(warcEntriesByDigest[warcPayloadDigest])
        }

        const combined = Buffer.concat(buffers)

        return {
          id,
          date: parseRawResourceDate(date),
          [`${type}Raw`]: combined,
          ...(combined.includes('\r\n\r\n') ? { [`${type}Parsed`]: await parsers[type](combined) } : {})
        }
      })
  )

  // sort based on id to order responses next to their requests
  rawProps = rawProps.sort(({ id }, { id: id2 }) => id.localeCompare(id2))

  for (const props of rawProps) {
    const prev = exchanges[exchanges.length - 1]
    if (prev && prev.id === props.id) {
      Object.assign(prev, props)
    } else {
      exchanges.push(new ScoopProxyExchange(props))
    }
  }

  return [...exchanges, ...generatedExchanges]
}
