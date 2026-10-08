import { chmod, link, lstat, mkdtemp, open, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

/**
 * Upper bound, in bytes, of the write queue between an export and its file.
 * @constant
 */
const WRITE_QUEUE_SIZE = 64 * 1024

/**
 * Checks the `path` given to a file export, before the export begins.
 *
 * @param {string} path - Absolute, or relative to the working directory.
 * @returns {string} The absolute destination.
 */
export function destinationPath (path) {
  if (typeof path !== 'string' || path === '') {
    throw new TypeError('"path" must be a non-empty string.')
  }

  return resolve(path)
}

/**
 * Writes chunks to a new file, asking for the next chunk only once the file
 * can take it. The file is closed when this settles.
 *
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {string} path - Must not exist: it is never opened if it does.
 * @returns {Promise<void>}
 */
export async function writeChunks (chunks, path) {
  const file = await open(path, 'wx', 0o600)

  try {
    await pipeline(chunks, file.createWriteStream({ highWaterMark: WRITE_QUEUE_SIZE }))
  } finally {
    await file.close()
  }
}

/**
 * Runs an export in a private directory beside its destination, then gives
 * the file it produced the destination's name.
 *
 * The directory is on the destination's filesystem, so that no intermediate
 * goes to another one, and so that publishing is a hard link: atomic, and
 * failing with `EEXIST` where a rename would replace an existing file or
 * follow a symbolic link. A destination only ever names a complete file.
 *
 * The directory is removed whether the export succeeds or fails. If that
 * fails, `log` is warned and told where the intermediates are, and the outcome
 * of the export stands.
 *
 * @param {string} destination - From `destinationPath`.
 * @param {{warn: function, trace: function}} log
 * @param {function(string): Promise<string>} produce - Given the private directory, resolves to the path of a closed file inside it.
 * @returns {Promise<void>}
 */
export async function publishFile (destination, log, produce) {
  // Fail before exporting anything. The link below is what settles a race.
  await assertAbsent(destination)

  const directory = await mkdtemp(join(dirname(destination), '.scoop-export-'))

  try {
    const produced = await produce(directory)
    await chmod(produced, 0o600)
    await link(produced, destination)
  } finally {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (err) {
      log.warn(`Intermediate files of the export to ${destination} were left in ${directory}, which could not be removed.`)
      log.trace(err)
    }
  }
}

/**
 * Rejects with `EEXIST` if anything has this name, including a symbolic link
 * to a file that does not exist.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
async function assertAbsent (path) {
  try {
    await lstat(path)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return
    }
    throw err
  }

  const error = new Error(`EEXIST: file already exists, '${path}'`)
  error.code = 'EEXIST'
  error.path = path
  throw error
}
