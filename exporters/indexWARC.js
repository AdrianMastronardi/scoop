import { createReadStream } from 'node:fs'
import { basename } from 'node:path'

import { CDXAndRecordIndexer } from 'warcio'

/**
 * warcio's CDX indexer, reading no more of a record than its index entry takes.
 *
 * As it comes, the indexer reads every record whole into memory before
 * indexing it. An index entry is made of a record's headers and offsets, and
 * of nothing in its content but the body of a request, from which the URL of
 * a request other than a GET is derived. Here every other record is skipped
 * through instead, a chunk at a time.
 */
class RecordIndexer extends CDXAndRecordIndexer {
  /**
   * `CDXIndexer.iterRecords` of warcio 2.4.12, but for what it reads.
   * @override
   */
  async * iterRecords (parser, filename) {
    this._lastRecord = null

    for await (const record of parser) {
      if (record.warcType === 'request') {
        await record.readFully()
      } else {
        await record.skipFully()
      }

      const result = this.indexRecord(record, parser, filename)
      if (result) {
        yield result
      }
    }

    const result = this.indexRecord(null, parser, filename)
    if (result) {
      yield result
    }
  }
}

/**
 * Indexes a .warc or .warc.gz file as CDXJ.
 *
 * Worker function: Scoop gives it to the pool that `@harvard-lil/js-wacz`
 * indexes with, in place of that package's own `workers/indexWARC.js`. It
 * returns the same entries, without holding a whole record in memory to do so.
 * It does not detect pages: Scoop lists the pages of a capture itself.
 *
 * @param {Object} options
 * @param {string} options.filename
 * @returns {Promise<{cdx: string[], pages: object[]}>}
 */
export default async function indexWARC ({ filename }) {
  const output = { cdx: [], pages: [] }
  const indexer = new RecordIndexer()
  const stream = createReadStream(filename)

  try {
    for await (const { cdx } of indexer.iterIndex([{ reader: stream, filename: basename(filename) }])) {
      const cdxj = indexer.serializeCDXJ(cdx)

      if (cdxj) {
        output.cdx.push(cdxj)
      }
    }
  } finally {
    stream.destroy()
  }

  return output
}
