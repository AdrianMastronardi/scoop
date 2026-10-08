// Readers for the export tests that share no code with what wrote the archive:
// node:zlib and node:crypto, where the exporters use warcio and its hashes.
import { inflateRawSync } from 'node:zlib'

const CRLF = Buffer.from('\r\n')
const HEAD_END = Buffer.from('\r\n\r\n')

/** A header block as its first line and its fields, in order, names lower-cased. */
function head (bytes) {
  const [startLine, ...lines] = bytes.toString('latin1').split('\r\n')
  const fields = lines.map(line => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()])
  return { startLine, fields, get: name => fields.find(([field]) => field === name)?.[1] }
}

/**
 * Parses an uncompressed WARC into records, checking each one's framing.
 * `block` is what Content-Length counts; `http` and `payload` split it for
 * the records that hold an HTTP message.
 */
export function parseWARC (bytes) {
  const records = []

  for (let offset = 0; offset < bytes.length;) {
    const end = bytes.indexOf(HEAD_END, offset)
    if (end === -1) throw new Error(`No WARC header block at ${offset}`)

    const warc = head(bytes.subarray(offset, end))
    const length = Number(warc.get('content-length'))
    const block = bytes.subarray(end + 4, end + 4 + length)
    if (block.length !== length || !bytes.subarray(end + 4 + length, end + 8 + length).equals(HEAD_END)) {
      throw new Error(`Record at ${offset} does not end where its Content-Length says`)
    }

    const record = { version: warc.startLine, type: warc.get('warc-type'), warc, block }
    if (warc.get('content-type')?.startsWith('application/http')) {
      const split = block.indexOf(HEAD_END)
      record.http = head(block.subarray(0, split))
      record.payload = block.subarray(split + 4)
    }

    records.push(record)
    offset = end + 8 + length
  }

  return records
}

/**
 * Splits a gzip file into its members, without relying on their being records.
 * @returns {{offset: number, length: number, data: Buffer}[]}
 */
export function gzipMembers (bytes) {
  const members = []

  for (let offset = 0; offset < bytes.length;) {
    // A member written by zlib: a 10-byte header without optional fields,
    // a deflate stream, then 8 bytes of CRC-32 and length.
    if (bytes[offset] !== 0x1f || bytes[offset + 1] !== 0x8b || bytes[offset + 3] !== 0) {
      throw new Error(`No plain gzip member at ${offset}`)
    }
    const { buffer, engine } = inflateRawSync(bytes.subarray(offset + 10), { info: true })
    const length = 10 + engine.bytesWritten + 8
    if (bytes.readUInt32LE(offset + length - 4) !== buffer.length) {
      throw new Error(`Gzip member at ${offset} does not end with its length`)
    }

    members.push({ offset, length, data: buffer })
    offset += length
  }

  return members
}

/** The records of a WARC file, each of which must be its own member if gzipped. */
export function readWARC (bytes, gzip) {
  if (!gzip) {
    return parseWARC(bytes)
  }

  return gzipMembers(bytes).map(member => {
    const records = parseWARC(member.data)
    if (records.length !== 1) throw new Error(`Gzip member at ${member.offset} holds ${records.length} records`)
    return { ...records[0], offset: member.offset, length: member.length }
  })
}

/** The lines of a CDXJ index as `{ urlkey, timestamp, ...fields }`. */
export function parseCDXJ (text) {
  return text.split('\n').filter(Boolean).map(line => {
    const [urlkey, timestamp] = line.split(' ', 2)
    return { urlkey, timestamp, ...JSON.parse(line.slice(urlkey.length + timestamp.length + 2)) }
  })
}

export { CRLF }
