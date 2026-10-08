/// <reference path="./options.types.js" />

import os from 'os'
import { performance } from 'node:perf_hooks'
import { initializeMultipage, multipageState, multipageSnapshot, validateUrls, validateInventory, validateAssessment, artifactSummary, artifactPrefix, projectedFields, StepFailure, MAX_ATTEMPTS } from './utils/multipage.js'
import { observeNavigation, associateTarget } from './utils/page-navigation.js'
import { CaptureTlsErrors } from './utils/tls-errors.js'
import { readFile, readdir, mkdir, access } from 'fs/promises'
import { constants as fsConstants } from 'node:fs'
import { createHash } from 'crypto'

import log from 'loglevel'
import logPrefix from 'loglevel-plugin-prefix'
import nunjucks from 'nunjucks'
import { Address4, Address6 } from '@laverdet/beaugunderson-ip-address'
import { v4 as uuidv4 } from 'uuid'
import { chromium, errors as playwrightErrors } from 'playwright'

import { exec, omitEnvironmentVariables } from './utils/exec.js'
import { ScoopGeneratedExchange } from './exchanges/index.js'
import { castBlocklistMatcher, searchBlocklistFor } from './utils/blocklist.js'

import * as CONSTANTS from './constants.js'
import * as intercepters from './intercepters/index.js'
import * as exporters from './exporters/index.js'
import * as importers from './importers/index.js'
import { filterOptions, defaults } from './options.js'
import { formatErrorMessage } from './utils/formatErrorMessage.js'
import { getOSInfo } from './utils/os-info.js'
import { getDimensions } from './utils/png.js'
import { NetworkPolicy, fetchHead } from './utils/network.js'
import { createCertificateTunnel } from './utils/certificate-tunnel.js'
import { withSnapshotDeadline, SnapshotTimeoutError } from './utils/snapshot-deadline.js'
import { forEachHttpsHostWithinBudget } from './utils/host-budget.js'
import { createArtifactScratchDirectory, readArtifactFile, removeArtifactScratchDirectory } from './utils/artifact-files.js'

nunjucks.configure(CONSTANTS.TEMPLATES_PATH)
const archiveReconstruction = Symbol('archiveReconstruction')

/**
 * How long closing a page of an array capture may take, in ms.
 * A page still open after that is doing work in the shared session, which ends there.
 */
const PAGE_CLOSE_TIMEOUT = 5000

/**
 * @class Scoop
 *
 * @classdesc
 * Experimental web archiving library using Playwright.
 * Uses a proxy to allow for comprehensive and raw network interception.
 *
 * @example
 * import { Scoop } from "scoop";
 *
 * const myCapture = await Scoop.capture("https://example.com");
 * const myArchive = await myCapture.toWARC();
 */
export class Scoop {
  /** @type {string} */
  id = uuidv4()

  /**
   * Enum-like states that the capture occupies.
   * @readonly
   * @enum {number}
   */
  static states = {
    INIT: 0,
    SETUP: 1,
    CAPTURE: 2,
    COMPLETE: 3,
    PARTIAL: 4,
    FAILED: 5,
    RECONSTRUCTED: 6
  }

  /**
   * Current state of the capture.
   * Should only contain states defined in `states`.
   * @type {number}
   */
  state = Scoop.states.INIT
  #browserClosedAfterSnapshotTimeout = false
  #context
  #activeRun = null
  #recordingStop = null
  #deadline = Infinity
  #captureTimer
  #generatedBytes = 0
  #stepNumber = 0
  #sessionFailed = false
  #assessment = null
  #closingPages = new Set()
  #tls = new CaptureTlsErrors()
  #unobserveTls

  /**
   * Independent snapshot of the page inventory; absent for string captures.
   * @type {ScoopMultipage|undefined}
   */
  get multipage () { return multipageSnapshot(this) }

  /** Independent structured TLS diagnostics, including failed captures.
   * @type {ScoopCaptureError[]}
   */
  get errors () { return this.#tls.errors }

  /** Internal proxy hook: bind ownership before asynchronous authorization. @ignore */
  trackTlsRequest (request, target) { this.#tls.admit(request, target) }

  /** Internal proxy hook: retain verification failures before downstream closure. @ignore */
  recordProxyTlsError (error, request) {
    this.#tls.policyError(error, request)
    return this.#tls.proxyError(error, request)
  }

  /** Restore descriptive archive diagnostics, never executable policy. @ignore */
  restoreCaptureErrors (errors) { this.#tls.restore(errors, this.multipage) }

  #finishTlsRun (run) {
    if (this.#tls.failed(run)) {
      run.state = Scoop.states.FAILED
      if (run !== this) run.reason = 'tls_validation_failed'
    } else if (this.#tls.partial(run) && [Scoop.states.CAPTURE, Scoop.states.COMPLETE].includes(run.state)) {
      run.state = Scoop.states.PARTIAL
      if (run !== this) run.reason = 'tls_validation_failed'
    }
    this.#tls.end(run)
  }

  /** Called by the intercepter when the shared received-byte budget expires. */
  stopRecording (reason) {
    if (!multipageState(this)) {
      if (!this.#tls.failed(this)) this.state = Scoop.states.PARTIAL
      this.intercepter.recordExchanges = false
      return true
    }
    if (this.#recordingStop) return false
    this.#recordingStop = reason
    this.intercepter.recordExchanges = false
    // An assessment still pending decides nothing once the session has stopped.
    this.#assessment?.abort()
    if (this.#activeRun && !this.#tls.failed(this.#activeRun)) {
      this.#activeRun.state = Scoop.states.PARTIAL
      this.#activeRun.reason = this.#recordingStop
    }
    return true
  }

  /** Generated bytes charged to the shared array-mode capture budget. */
  get generatedByteLength () {
    return multipageState(this) && !this.options.attachmentsBypassLimits ? this.#generatedBytes : 0
  }

  #remaining (timeout) {
    return multipageState(this) ? Math.max(1, Math.floor(Math.min(timeout, this.#deadline - performance.now()))) : timeout
  }

  /**
   * URL to capture.
   * @type {string}
   */
  url = ''

  /**
   * URL to capture, resolved to account for redirects.
   * Populated during non-web content detection step.
   * @type {string}
   */
  targetUrlResolved = ''

  /**
   * Is the target url a web page?
   * Assumed `true` until detected otherwise.
   * @type {boolean}
   */
  targetUrlIsWebPage = true

  /**
   * Content-type of the target url.
   * Assumed `text/html` unless detected otherwise.
   * @type {string}
   */
  targetUrlContentType = 'text/html; charset=utf-8'

  /**
   * Current settings.
   * @type {ScoopOptions}
   */
  options = {}

  /**
   * Returns a copy of Scoop's default settings.
   * @type {ScoopOptions}
   */
  static get defaults () {
    return Object.assign({}, defaults)
  }

  /**
   * Array of HTTP exchanges that constitute the capture.
   * Only contains generated exchanged until `teardown()`.
   * @type {ScoopExchange[]}
   */
  exchanges = []

  /**
   * Logger.
   * Logging level controlled via the `logLevel` option.
   * @type {?log.Logger}
   */
  log = log

  /**
   * Path to the capture-specific temporary folder created by `setup()`.
   * Will be a child folder of the path defined in `CONSTANTS.TMP_PATH`.
   * @type {?string}
   */
  captureTmpFolderPath = null

  #captureScratchDirectory = null

  /**
   * The time at which the page was crawled.
   * @type {Date}
   */
  startedAt

  /**
   * What each capture step did and how long it took, in the order they ran.
   * `outcome` is one of:
   * - `completed`: the step finished on its own.
   * - `failed`: the step threw.
   * - `limit`: the step ended because the capture reached its time or size limit.
   * - `interrupted`: the capture left the CAPTURE state while the step was still running; Scoop moved on without waiting for it.
   * - `skipped`: the step did not run.
   *
   * In array mode each record also has an `id`, its `pageId` and `attemptNumber` (both null for
   * global steps) and a `reason`: see {@link ScoopMultipageStep}. The steps of every visit made
   * to a page are here, in order, while a page of the inventory lists those of its last visit.
   * @type {{name: string, startedAt: string, durationMs: number, outcome: string}[]}
   */
  steps = []

  /**
   * The Playwright browser instance for this capture.
   * @type {Browser}
   */
  #browser

  /**
   * Reference to the intercepter chosen for capture.
   * @type {intercepters.ScoopIntercepter}
   */
  intercepter

  /**
   * A mirror of options.blocklist with IPs parsed for matching
   * @type {Array.<String|RegEx|Address4|Address6>}
   */
  blocklist = []

  /**
   * Captures information about the context of this capture.
   * @type {{
   *   captureIp: ?string,
   *   userAgent: ?string,
   *   software: ?string,
   *   version: ?string,
   *   osType: ?string,
   *   osName: ?string,
   *   osVersion: ?string,
   *   cpuArchitecture: ?string,
   *   blockedRequests: Array.<{match: string, rule: string}>,
   *   certificates: Array.<{host: string, pem: string}>,
   *   ytDlpHash: string,
   *   cripHash: string,
   *   options: ScoopOptions,
   * }}
   */
  provenanceInfo = {
    blockedRequests: [],
    certificates: []
  }

  /**
   * Info extracted by the browser about the page on initial load
   * @type {{
   *   title: ?string,
   *   description: ?string,
   *   url: ?string,
   *   faviconUrl: ?string,
   *   favicon: ?Buffer
   * }}
   */
  pageInfo = {}

  /**
   * @param {string|string[]} url - HTTP(S) URL or an ordered, non-empty list of URLs.
   * @param {?ScoopOptions} [options={}] - See {@link ScoopOptions}.
   */
  constructor (url, options = {}, mode) {
    this.options = filterOptions(options)
    this.blocklist = this.options.blocklist.map(castBlocklistMatcher)
    if (Array.isArray(url) && mode !== archiveReconstruction) {
      const urls = validateUrls(url).map((value, index) => {
        try { return this.filterUrl(value) } catch (error) { throw new TypeError(`URL at index ${index}: ${error.message}`) }
      })
      initializeMultipage(this, urls)
      this.url = urls[0]
    } else {
      this.url = mode === archiveReconstruction ? url : this.filterUrl(url)
    }
    if (mode === archiveReconstruction) this.state = Scoop.states.RECONSTRUCTED
    this.targetUrlResolved = this.url

    // Logging setup (level, output formatting)
    logPrefix.reg(this.log)
    logPrefix.apply(log, {
      format (level, _name, timestamp) {
        const timestampColor = CONSTANTS.LOGGING_COLORS.DEFAULT
        const msgColor = CONSTANTS.LOGGING_COLORS[level.toUpperCase()]
        return `${timestampColor(`[${timestamp}]`)} ${msgColor(level)}`
      }
    })
    this.log.setLevel(this.options.logLevel)

    this.intercepter = new intercepters[this.options.intercepter](this)
  }

  /** Reconstruct historical HTTP data without executing its stored options or live URL policy. */
  static fromArchive (url) {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Invalid archive page URL.')
    return new Scoop(parsed.href, {}, archiveReconstruction)
  }

  /**
   * Instantiates a Scoop instance and runs the capture
   *
   * @param {string|string[]} url - HTTP(S) URL or an ordered, non-empty list of URLs.
   * @param {ScoopOptions} [options={}] - See {@link ScoopOptions}.
   * @returns {Promise<Scoop>}
   */
  static async capture (url, options) {
    const instance = new Scoop(url, options)
    await instance.capture()
    return instance
  }

  /**
   * Main capture process (internal).
   * @returns {Promise<void>}
   * @private
   */
  async capture () {
    if (this.state === Scoop.states.RECONSTRUCTED) throw new Error('Reconstructed captures cannot be recaptured.')
    try {
      if (multipageState(this)) await this.#capturePages()
      else await this.#capture()
    } finally {
      await this.#removeScratchDirectory()
    }
  }

  async #removeScratchDirectory () {
    if (!this.#captureScratchDirectory) return
    await removeArtifactScratchDirectory(this.#captureScratchDirectory)
    this.#captureScratchDirectory = null
  }

  #captureSteps (run = this) {
    const options = this.options

    /**
     * @typedef {object} CaptureStep
     * @property {string} name
     * @property {?function} setup
     * @property {?function} main
     * @property {?boolean} alwaysRun - If true, this step will run regardless of capture-level time / size constraints.
     * @property {?boolean} webPageOnly - If true, this step will only run if the target url is a web page. Takes precedence over `alwaysRun`.
     * @property {?boolean} navigation - If true, this step is the navigation to the target: what its failure is recorded as, in array mode, when nothing says more.
     * @property {?boolean} artifact - If true, this step generates an attachment: what its failure is recorded as, in array mode, when nothing says more.
     */

    /** @type {CaptureStep[]} */
    const steps = []

    //
    // Prepare capture steps
    //

    // Push step: early detection of non-web resources
    steps.push({
      name: 'Out-of-browser detection and capture of non-web resource',
      alwaysRun: true,
      webPageOnly: false,
      main: async (page) => {
        await this.#detectAndCaptureNonWebContent(page, run)
      }
    })

    // Push step: Wait for initial page load
    steps.push({
      name: 'Wait for initial page load',
      alwaysRun: false,
      webPageOnly: true,
      navigation: true,
      main: async (page) => {
        await page.goto(run.url, { waitUntil: 'load', timeout: this.#remaining(options.loadTimeout) })
        // The proxy answers for a destination that policy refuses: the navigation ends, without its target.
        if (run !== this && this.#tls.blocked(run)) throw new StepFailure('network_policy_blocked')
      }
    })

    // Push step: Capture page info
    steps.push({
      name: 'Capture page info',
      alwaysRun: options.attachmentsBypassLimits,
      webPageOnly: true,
      main: async (page) => {
        await this.#capturePageInfo(page, run)
      }
    })

    // Push step: Browser scripts
    if (
      options.grabSecondaryResources ||
      options.autoPlayMedia ||
      options.runSiteSpecificBehaviors ||
      options.autoScroll
    ) {
      steps.push({
        name: 'Browser scripts',
        alwaysRun: false,
        webPageOnly: true,
        setup: async (page) => {
          // Determine path of `behaviors.js`
          let behaviorsPath = './node_modules/browsertrix-behaviors/dist/behaviors.js'

          try {
            await access(behaviorsPath)
          } catch (_err) {
            behaviorsPath = `${CONSTANTS.BASE_PATH}/node_modules/browsertrix-behaviors/dist/behaviors.js`
          }

          await page.addInitScript({
            path: behaviorsPath
          })
          await page.addInitScript({
            content: `
              self.__bx_behaviors.init({
                autofetch: ${options.grabSecondaryResources},
                autoplay: ${options.autoPlayMedia},
                autoscroll: ${options.autoScroll},
                siteSpecific: ${options.runSiteSpecificBehaviors},
                timeout: ${options.behaviorsTimeout}
              });`
          })
        },
        main: async (page) => {
          await Promise.allSettled(
            page.frames().map((frame) => run === this
              ? frame.evaluate('self.__bx_behaviors.run()')
              : frame.evaluate(timeout => {
                globalThis.__bx_behaviors.timeout = timeout
                return globalThis.__bx_behaviors.run()
              }, this.#remaining(options.behaviorsTimeout)))
          )
        }
      })
    }

    // Push step: Wait for network idle
    steps.push({
      name: 'Wait for network idle',
      alwaysRun: false,
      webPageOnly: true,
      main: async (page) => {
        await page.waitForLoadState('networkidle', { timeout: this.#remaining(options.networkIdleTimeout) })
      }
    })

    // Push step: scroll up
    steps.push({
      name: 'Scroll-up',
      alwaysRun: options.attachmentsBypassLimits,
      webPageOnly: true,
      main: async (page) => {
        await Promise.race([
          page.evaluate(() => window.scrollTo(0, 0)),
          new Promise(resolve => setTimeout(resolve, 2500)) // Only wait for up to 2.5s for scroll up to happen
        ])
      }
    })

    // Push step: Screenshot
    if (options.screenshot) {
      steps.push({
        name: 'Screenshot',
        alwaysRun: options.attachmentsBypassLimits,
        webPageOnly: true,
        artifact: true,
        main: async (page) => {
          const url = 'file:///screenshot.png'
          const httpHeaders = new Headers({ 'content-type': 'image/png' })
          const body = await page.screenshot({ fullPage: true, timeout: 5000, ...this.#screenshotClip() })
          const [width, height] = this.#pngDimensions(body, run)
          if (width === options.screenshotMaxWidth || height === options.screenshotMaxHeight) {
            this.log.info(`Screenshot reached its size limit (${width}x${height}); the page may extend beyond it.`)
          }
          const isEntryPoint = true
          const description = `Capture Time Screenshot of ${run.url}`

          this.#addArtifact(url, httpHeaders, body, isEntryPoint, description, run)
        }
      })
    }

    // Push step: DOM Snapshot
    if (options.domSnapshot) {
      steps.push({
        name: 'DOM snapshot',
        alwaysRun: options.attachmentsBypassLimits,
        webPageOnly: true,
        artifact: true,
        main: async (page) => {
          const url = 'file:///dom-snapshot.html'
          const httpHeaders = new Headers({
            'content-type': 'text/html',
            'content-disposition': 'Attachment'
          })
          const body = Buffer.from(run === this
            ? await this.#browserSnapshot(() => page.content(), 'DOM', run)
            : await this.#pageSnapshot(() => page.content(), 'DOM', run, page))
          const isEntryPoint = true
          const description = `Capture Time DOM Snapshot of ${run.url}`

          this.#addArtifact(url, httpHeaders, body, isEntryPoint, description, run)
        }
      })
    }

    // Push step: PDF Snapshot
    if (options.pdfSnapshot) {
      steps.push({
        name: 'PDF snapshot',
        alwaysRun: options.attachmentsBypassLimits,
        webPageOnly: true,
        artifact: true,
        main: async (page) => {
          if (this.#browserClosedAfterSnapshotTimeout) return
          await this.#browserSnapshot(() => this.#takePdfSnapshot(page, run), 'PDF', run)
        }
      })
    }

    // Push step: Capture of in-page videos as attachment
    if (options.captureVideoAsAttachment) {
      steps.push({
        name: 'Out-of-browser capture of video as attachment (if any)',
        alwaysRun: options.attachmentsBypassLimits,
        webPageOnly: true,
        artifact: true,
        main: async () => {
          await this.#captureVideoAsAttachment(run)
        }
      })
    }

    // Push step: certs capture
    if (options.captureCertificatesAsAttachment) {
      steps.push({
        name: 'Capturing certificates info',
        global: true,
        alwaysRun: options.attachmentsBypassLimits,
        webPageOnly: false,
        artifact: true,
        main: async () => {
          await this.#captureCertificatesAsAttachment()
        }
      })
    }

    // Push step: Provenance summary
    if (options.provenanceSummary) {
      steps.push({
        name: 'Provenance summary',
        global: true,
        alwaysRun: options.attachmentsBypassLimits,
        webPageOnly: false,
        artifact: true,
        main: async (page) => {
          await this.#captureProvenanceInfo(page)
        }
      })
    }

    return steps
  }

  async #capture () {
    const options = this.options
    const steps = this.#captureSteps()

    //
    // Initialize capture
    //
    let page

    try {
      page = await this.setup()
      this.log.info(`Scoop ${CONSTANTS.VERSION} was initialized with the following options:`)
      this.log.info(options)
      this.log.info(`🍨 Starting capture of ${this.url}.`)
      this.state = Scoop.states.CAPTURE
    } catch (err) {
      this.log.error(`An error occurred during capture setup (${formatErrorMessage(err)}).`)
      this.log.trace(err)
      this.state = Scoop.states.FAILED
      await this.teardown()
      return // exit early if the browser and proxy couldn't be launched
    }

    this.#tls.begin(this, page, null)
    await this.#runSteps(steps, page)

    //
    // Post-capture
    //
    if (this.state === Scoop.states.CAPTURE) {
      this.state = Scoop.states.COMPLETE
    }

    await this.teardown()
    this.#finishTlsRun(this)
    if (this.state === Scoop.states.COMPLETE && this.#tls.hasErrors) this.state = Scoop.states.PARTIAL
  }

  async #capturePages () {
    const storage = multipageState(this)
    const inventory = storage.data
    // A page that failed for want of a required artifact, or on the deadline of a snapshot,
    // was visited: what its visits recorded is kept, and worth exporting.
    const retained = p => ['complete', 'partial'].includes(p.outcome) || (p.outcome === 'failed' && ['artifact_missing', 'snapshot_timeout'].includes(p.reason))
    const outcomeState = (sessionFailed = this.#sessionFailed) => {
      if (inventory.pages.every(p => p.outcome === 'complete') && !this.#recordingStop && !sessionFailed && !this.#tls.hasErrors) return Scoop.states.COMPLETE
      if (inventory.pages.some(retained)) return Scoop.states.PARTIAL
      return Scoop.states.FAILED
    }
    let setupFailed = false
    try {
      try {
        await this.setup()
        this.state = Scoop.states.CAPTURE
        this.log.info(`Starting capture of ${inventory.urls.length} targets with one shared budget: ${this.options.captureTimeout}ms and ${this.options.maxCaptureSize} bytes.`)
      } catch (error) {
        setupFailed = true
        this.log.error(`Capture setup failed (${formatErrorMessage(error)}).`)
        this.log.trace(error)
      }
      inventory.startedAt = (this.startedAt || new Date()).toISOString()
      for (const row of inventory.pages) {
        if (!this.#recordingStop && performance.now() >= this.#deadline) this.stopRecording('capture_timeout')
        if (setupFailed || this.#sessionFailed || this.#recordingStop) {
          row.outcome = 'skipped'
          row.reason = setupFailed ? 'shared_setup_failed' : this.#recordingStop || 'session_failed'
          continue
        }
        // One visit, and one more if the assessment of the first asks for it and nothing forbids it.
        let run
        do {
          run = await this.#visitPage(row, row.attempts.length + 1, storage)
        } while (await this.#assessAttempt(row, run))
        // What the page entry says of itself is what its last visit says.
        const last = row.attempts.at(-1)
        for (const field of projectedFields) row[field] = last[field]
        if (row.id === inventory.pages[0].id) {
          this.targetUrlIsWebPage = run.targetUrlIsWebPage
          this.targetUrlContentType = run.targetUrlContentType
          this.targetUrlResolved = row.resolvedUrl || this.url
          this.pageInfo = { ...run.pageInfo }
        }
      }
      inventory.finishedAt = new Date().toISOString()
      validateInventory(inventory, this.intercepter.exchanges.concat(this.exchanges), this.steps)
      const state = outcomeState()
      if (state !== Scoop.states.FAILED) {
        const global = {
          active: true,
          state: state === Scoop.states.COMPLETE ? Scoop.states.CAPTURE : state,
          reason: this.#recordingStop || inventory.pages.find(p => p.reason)?.reason || 'session_failed',
          targetUrlIsWebPage: false,
          steps: inventory.globalSteps,
          stepController: new AbortController()
        }
        this.#activeRun = global
        this.#tls.begin(global)
        await this.#runSteps(this.#captureSteps().filter(step => step.global), null, global)
        global.active = false
        this.#tls.end(global)
        this.#activeRun = null
        // The provenance step copied the inventory while it was still running.
        if (this.provenanceInfo.multipage) this.provenanceInfo.multipage = this.multipage
      }
    } finally {
      const sessionFailed = this.#sessionFailed
      clearTimeout(this.#captureTimer)
      // Close every shared resource even if validation or a helper failed.
      try { await this.intercepter.teardown() } finally {
        try { await this.#browser?.close() } finally {
          this.exchanges = this.intercepter.exchanges.concat(this.exchanges)
          this.#activeRun = null
          this.#unobserveTls?.()
          this.state = setupFailed ? Scoop.states.FAILED : outcomeState(sessionFailed)
          await this.#removeScratchDirectory()
        }
      }
    }
  }

  /**
   * Makes one visit to a page of an array capture, on a page of its own, and records it
   * as the next entry of the page's `attempts`.
   * @returns {Promise<object>} The run of that visit, closed.
   */
  async #visitPage (row, attemptNumber, storage) {
    const run = {
      id: row.id,
      attemptNumber,
      prefix: artifactPrefix(row.id, attemptNumber),
      url: row.requestedUrl,
      state: Scoop.states.CAPTURE,
      reason: null,
      targetUrlIsWebPage: true,
      targetUrlContentType: 'text/html; charset=utf-8',
      targetUrlResolved: row.requestedUrl,
      pageInfo: {},
      steps: [],
      pages: new Set(),
      active: true,
      exchangeStart: this.intercepter.exchanges.length,
      exchangeEnd: null,
      helperFinished: false,
      stepController: new AbortController()
    }
    const attempt = {
      pageId: row.id,
      attemptNumber,
      requestedUrl: row.requestedUrl,
      resolvedUrl: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: 'capturing',
      reason: null,
      httpStatus: null,
      contentType: null,
      pageInfo: {},
      entryPoint: null,
      exchangeIds: [],
      attachments: {},
      steps: run.steps
    }
    // Published as it starts: an observer sees which visit is under way, and that it is one more.
    row.attempts.push(attempt)
    row.retryCount = attemptNumber - 1
    for (const field of projectedFields) row[field] = attempt[field]
    this.#activeRun = run
    let page
    let unobserve
    let scratch
    try {
      scratch = await createArtifactScratchDirectory(this.captureTmpFolderPath)
      run.captureTmpFolderPath = scratch.path + '/'
      page = await this.#context.newPage()
      this.#tls.begin(run, page)
      await page.setViewportSize({ width: this.options.captureWindowX, height: this.options.captureWindowY })
      const session = await this.#context.newCDPSession(page)
      await session.send('Network.enable')
      await session.send('Network.setCacheDisabled', { cacheDisabled: true })
      // Keep this session attached until page closure; detaching resets cache policy.
      unobserve = observeNavigation(page, run, () => this.#recordingStop)
      await this.#runSteps(this.#captureSteps(run).filter(step => !step.global), page, run)
    } catch (error) {
      run.state = Scoop.states.FAILED
      run.reason = 'page_closed'
      this.log.warn(`[${row.id}] Page attempt failed (${formatErrorMessage(error)}).`)
      this.log.trace(error)
    } finally {
      run.stepController.abort()
      // Disable admission before closing popups: closing a page can open another.
      run.active = false
      try {
        for (const owned of run.pages) if (owned !== page) await this.#closePage(owned)
        if (page) await this.#closePage(page)
        while (this.#closingPages.size) await Promise.all(this.#closingPages)
        // A page that will not close within its bound is still doing work in the shared session.
        if ((page && !page.isClosed()) || [...run.pages].some(owned => !owned.isClosed())) this.#sessionFailed = true
      } catch (error) {
        this.#sessionFailed = true
        this.log.warn(`[${row.id}] Page cleanup failed (${formatErrorMessage(error)}).`)
      }
      unobserve?.()
      run.blocked = this.#tls.blocked(run)
      this.#finishTlsRun(run)
      run.exchangeEnd = this.intercepter.exchanges.length
      const { chain, ...observation } = associateTarget(run, this.intercepter.exchanges)
      storage.chains.set(row.id, chain)
      if (run.state === Scoop.states.CAPTURE) run.state = Scoop.states.COMPLETE
      const outcome = Object.keys(Scoop.states).find(key => Scoop.states[key] === run.state).toLowerCase()
      Object.assign(attempt, observation, {
        outcome,
        reason: outcome === 'complete' ? null : run.reason || 'session_failed',
        pageInfo: JSON.parse(JSON.stringify({ ...run.pageInfo, favicon: undefined })),
        // By identity, and only what is retained: an exchange that never carried a byte is not exported.
        exchangeIds: this.intercepter.exchanges.slice(run.exchangeStart, run.exchangeEnd)
          .filter(exchange => exchange.requestRaw?.length || exchange.responseRaw?.length)
          .map(exchange => exchange.id),
        attachments: artifactSummary(this.exchanges, row.id, attemptNumber),
        finishedAt: new Date().toISOString()
      })
      this.#activeRun = null
      if (scratch) await removeArtifactScratchDirectory(scratch)
    }
    return run
  }

  /**
   * Has the visit just made to a page assessed, records what the assessment said, and tells
   * whether the page is to be visited again.
   *
   * The page is visited again when its visit had nothing against it but required artifacts that
   * are missing or invalid, the assessment allows it, it was the first visit, and the session is
   * still running within its budget. Otherwise the visit keeps the outcome Scoop observed, or
   * fails with `artifact_missing` when missing artifacts were all it had against it.
   *
   * @returns {Promise<boolean>}
   */
  async #assessAttempt (row, run) {
    const attempt = row.attempts.at(-1)
    const stopped = () => this.#recordingStop || this.#sessionFailed || performance.now() >= this.#deadline
    // Once the session has stopped nothing new is admitted, an assessment no more than a visit.
    if (stopped()) return false

    const controller = this.#assessment = new AbortController()
    let assessment
    try {
      assessment = validateAssessment(await Promise.race([
        // A copy: nothing done to it reaches the inventory.
        Promise.resolve().then(() => this.assessPageAttempt(structuredClone(attempt), controller.signal)),
        new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
      ]))
    } catch (error) {
      if (controller.signal.aborted) {
        // Stopped while it was assessed: a visit without its assessment is not a success.
        if (attempt.outcome === 'complete') Object.assign(attempt, { outcome: 'partial', reason: this.#recordingStop || 'session_failed' })
      } else {
        // The capture can no longer tell what to do with its pages: it ends here, keeping what it has.
        this.#sessionFailed = true
        Object.assign(attempt, { outcome: 'failed', reason: 'session_failed' })
        this.log.error(`[${row.id}] Assessment of visit ${attempt.attemptNumber} failed (${formatErrorMessage(error)}). Ending the session.`)
        this.log.trace(error)
      }
      return false
    } finally {
      this.#assessment = null
    }

    Object.assign(attempt, assessment)
    // Missing artifacts are the outcome of a visit only when nothing else is: not when Scoop
    // itself saw it fail or stop short, get an HTTP error or have its target refused by policy.
    const eligible = attempt.outcome === 'complete' && !(attempt.httpStatus >= 400) && !run.blocked
    if (!eligible || !assessment.retryAllowed || !assessment.missingArtifacts.length) return false
    Object.assign(attempt, { outcome: 'failed', reason: 'artifact_missing' })
    if (attempt.attemptNumber >= MAX_ATTEMPTS || stopped()) return false
    this.log.info(`[${row.id}] Required artifacts are missing (${assessment.missingArtifacts.join(', ')}): visiting the page once more.`)
    return true
  }

  /**
   * Closes a page, waiting no longer than `PAGE_CLOSE_TIMEOUT` for it.
   * @returns {Promise<boolean>} Whether the page is closed.
   */
  async #closePage (page) {
    let timer
    await Promise.race([
      page.close().catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, PAGE_CLOSE_TIMEOUT) })
    ])
    clearTimeout(timer)
    return page.isClosed()
  }

  /**
   * Assesses a visit just made to a page of an array capture, to tell Scoop whether artifacts
   * that the caller requires of it are missing. Meant to be overridden: as it comes, it requires
   * nothing, so that no page is ever visited twice.
   *
   * Scoop awaits it after each visit it made, the second to a page included, once the pages of
   * that visit are closed and what it recorded is final, and before going on to the next visit
   * or page. It is not called for a page that was not visited, nor once the session has stopped.
   *
   * - `missingArtifacts` lists, without repeats, the required artifacts that the visit lacks or
   *   that are not valid: Scoop knows that an artifact was generated, not that its bytes are good.
   * - `retryAllowed` tells whether those artifacts are all that the visit has against it, in
   *   the caller's eyes. Scoop still decides: it visits a page at most twice, never after a
   *   visit that it saw fail, stop short, receive an HTTP error or have its target refused by
   *   network policy, and never once the shared budget is spent or the session stopped.
   *
   * A visit that ends with missing artifacts and `retryAllowed` fails with `artifact_missing`
   * if nothing else was against it, and if it was the first, the page is visited once more.
   * With `retryAllowed: false` the visit keeps the outcome Scoop observed.
   *
   * Throwing, or returning anything else than the above, ends the session as failed: no page
   * is visited after that, and what was captured is kept. `signal` aborts when the session
   * stops while the assessment is pending; what it then returns is ignored.
   *
   * @param {Readonly<ScoopPageAttempt>} attempt - An independent copy of the visit's record. It references exchanges and attachments by id and name, without their bodies.
   * @param {AbortSignal} signal
   * @returns {Promise<{missingArtifacts: Array<'screenshot'|'domSnapshot'|'certificates'>, retryAllowed: boolean}>}
   */
  async assessPageAttempt (attempt, signal) { // eslint-disable-line no-unused-vars
    return { missingArtifacts: [], retryAllowed: false }
  }

  async #runSteps (steps, page, run = this) {
    //
    // Call `setup()` method of steps that have one
    //
    for (const step of steps.filter((step) => step.setup)) {
      await step.setup(page)
    }

    //
    // Run capture steps
    //
    let i = -1
    while (i++ < steps.length - 1) {
      const step = steps[i]

      //
      // Edge cases requiring immediate interruption
      //
      let shouldStop = false
      const primaryTlsFailure = this.#tls.failed(run)
      if (primaryTlsFailure) {
        run.state = Scoop.states.FAILED
        if (run !== this) run.reason = 'tls_validation_failed'
      }

      // Page is a web document and is still "about:blank" after step #2
      if (!primaryTlsFailure && !run.terminal && page && run.targetUrlIsWebPage && i > 1 && page.url() === 'about:blank') {
        this.log.error('Navigation to page failed (about:blank).')
        if (run !== this) run.reason = 'navigation_error'
        shouldStop = true
      }

      // Page was closed
      if (!primaryTlsFailure && !run.terminal && page && run.targetUrlIsWebPage && page.isClosed() && !run.limitClosed && !this.#browserClosedAfterSnapshotTimeout) {
        this.log.error('Page closed before it could be captured.')
        if (run !== this) run.reason = 'page_closed'
        shouldStop = true
      }

      if (shouldStop) {
        run.state = Scoop.states.FAILED
        if (run === this) break
        // In array mode the steps that will not run are still recorded, with what stopped them.
        run.terminal = true
      }

      //
      // If capture was not interrupted, run steps
      //
      let stateCheckInterval = null
      const stepStartedAt = Date.now()
      const record = { name: step.name, startedAt: new Date(stepStartedAt).toISOString() }
      if (run !== this) {
        record.id = `step-${String(++this.#stepNumber).padStart(4, '0')}`
        record.pageId = run.id || null
        record.attemptNumber = run.attemptNumber ?? null
        record.reason = null
        run.stepController = new AbortController()
      }
      let operation
      try {
        // Only if state is `CAPTURE`, unless `alwaysRun` is set for step
        let shouldRun = (run.state === Scoop.states.CAPTURE || step.alwaysRun === true) && !(primaryTlsFailure && !step.global) && !run.terminal

        // BUT: `webPageOnly` takes precedence - allows for skipping unnecessary steps when capturing non-web content
        if (run.targetUrlIsWebPage === false && step.webPageOnly) {
          shouldRun = false
        }

        if (shouldRun === false) {
          this.log.warn(`${run === this ? '' : `[${run.id || 'capture'}] `}STEP [${i + 1}/${steps.length}]: ${step.name} (skipped)`)
          record.outcome = 'skipped'
          if (run !== this) record.reason = run.targetUrlIsWebPage === false && step.webPageOnly ? 'not_applicable' : run.reason
          continue
        }

        this.log.info(`${run === this ? '' : `[${run.id || 'capture'}] `}STEP [${i + 1}/${steps.length}]: ${step.name}`)

        operation = step.main(page)
        const interrupted = await Promise.race([
          // Run current step
          operation.then(() => false),

          // Check capture state every second - so current step can be interrupted if state changes
          new Promise(resolve => {
            stateCheckInterval = setInterval(() => {
              if (this.#tls.failed(run) || (run.state !== Scoop.states.CAPTURE && step.alwaysRun !== true)) {
                resolve(true)
              }
            }, 1000)
          })
        ])
        record.outcome = this.#tls.failed(run) ? 'failed' : interrupted ? 'interrupted' : 'completed'
        if (run !== this && record.outcome === 'failed') record.reason = 'tls_validation_failed'
        if (interrupted && (run !== this || this.#tls.failed(run))) {
          run.stepController?.abort()
          if (this.#tls.failed(run)) {
            await page?.close().catch(() => {})
          } else if (this.options.attachmentsBypassLimits && page && !page.isClosed()) {
            // Stop admitted network work, keeping the document for eligible attachments.
            const session = await this.#context.newCDPSession(page)
            try { await session.send('Page.stopLoading') } finally { await session.detach() }
            await Promise.allSettled(page.frames().map(frame => frame.evaluate(() => {
              try { globalThis.__bx_behaviors?.pause() } catch {}
            })))
          } else {
            run.limitClosed = true
            await page?.close().catch(() => {})
          }
          // Do not let a losing operation enter the next attempt.
          await operation.catch(() => {})
        }

      //
      // On error:
      // - Only deliver full trace if error is not due to time / size limit reached.
      //
      } catch (err) {
        if (this.#tls.failed(run)) {
          run.state = Scoop.states.FAILED
          if (run !== this) run.reason = 'tls_validation_failed'
        }
        if (run.state === Scoop.states.PARTIAL && (run === this || ['capture_timeout', 'capture_size_limit', 'snapshot_timeout', 'non_web_capture'].includes(run.reason))) {
          this.log.warn(`${run === this ? '' : `[${run.id || 'capture'}] `}STEP [${i + 1}/${steps.length}]: ${step.name} - ended due to max time or size reached.`)
          record.outcome = 'limit'
        } else {
          this.log.warn(`${run === this ? '' : `[${run.id || 'capture'}] `}STEP [${i + 1}/${steps.length}]: ${step.name} - failed`)
          this.log.trace(err)
          record.outcome = 'failed'
          if (run !== this) record.reason = this.#stepFailureReason(err, step, page, run)
        }
      } finally {
        clearInterval(stateCheckInterval)
        record.durationMs = Date.now() - stepStartedAt
        if (run !== this && ['limit', 'interrupted'].includes(record.outcome)) record.reason = run.reason
        this.steps.push(record)
        if (run !== this) run.steps.push(structuredClone(record))
      }
    }
  }

  /**
   * Why a step of an array capture failed, as one of a closed set of reasons.
   *
   * Goes by what is typed or observed, most specific first: a reason the step gave itself, the
   * kind of error, the state of the browser and of the page. Never by how long the step took,
   * and never by the text of an error, which stays in the logs. When none of those tells, the
   * reason is what the step was for, or `step_failed`.
   *
   * @returns {string} See `stepFailureReasons`.
   */
  #stepFailureReason (err, step, page, run) {
    if (this.#tls.failed(run)) return 'tls_validation_failed'
    if (err instanceof StepFailure) return err.reason
    if (err instanceof SnapshotTimeoutError) return 'snapshot_timeout'
    if (this.#browser && !this.#browser.isConnected()) return 'browser_disconnected'
    if (step.navigation && this.#tls.blocked(run)) return 'network_policy_blocked'
    if (err instanceof playwrightErrors.TimeoutError) return 'step_timeout'
    if (page?.isClosed()) return 'page_closed'
    if (step.navigation) return 'navigation_error'
    if (step.artifact) return 'artifact_generation_failed'
    return 'step_failed'
  }

  /**
   * The dimensions of a screenshot, which only PNG data has.
   * In array mode, bytes that are not are recorded as what made the step fail.
   * @returns {number[]} Width and height.
   */
  #pngDimensions (body, run) {
    try {
      return getDimensions(body)
    } catch (err) {
      throw run === this ? err : new StepFailure('artifact_invalid', { cause: err })
    }
  }

  /**
   * Adds the generated exchange that a step exists to produce.
   * In array mode a step that could not add it has failed, whatever kept it out.
   * @returns {boolean}
   */
  #addArtifact (url, headers, body, isEntryPoint, description, run) {
    const added = this.addGeneratedExchange(url, headers, body, isEntryPoint, description, run)
    if (!added && run !== this) throw new StepFailure('artifact_missing')
    return added
  }

  /**
   * Sets up the proxy and Playwright resources, creates capture-specific temporary folder.
   *
   * @returns {Promise<Page>} Resolves to a Playwright [Page]{@link https://playwright.dev/docs/api/class-page} object
   */
  async setup () {
    this.startedAt = new Date()
    this.state = Scoop.states.SETUP
    const options = this.options

    // Create "base" temporary folder if it doesn't exist
    let tmpDirExists = false
    try {
      await access(CONSTANTS.TMP_PATH)
      tmpDirExists = true
    } catch (_err) {
      this.log.info(`Base temporary folder ${CONSTANTS.TMP_PATH} does not exist or cannot be accessed. Scoop will attempt to create it.`)
    }

    if (!tmpDirExists) {
      try {
        await mkdir(CONSTANTS.TMP_PATH)
        await access(CONSTANTS.TMP_PATH, fsConstants.W_OK)
        tmpDirExists = true
      } catch (err) {
        this.log.warn(`Error while creating base temporary folder ${CONSTANTS.TMP_PATH} ((${formatErrorMessage(err)})).`)
        this.log.trace(err)
      }
    }

    // Create captures-specific temporary folder under base temporary folder
    try {
      this.#captureScratchDirectory = await createArtifactScratchDirectory(CONSTANTS.TMP_PATH)
      this.captureTmpFolderPath = this.#captureScratchDirectory.path + '/'
      await access(this.captureTmpFolderPath, fsConstants.W_OK)

      this.log.info(`Capture-specific temporary folder ${this.captureTmpFolderPath} created.`)
    } catch (err) {
      await this.#removeScratchDirectory()

      throw new Error(`Scoop was unable to create a capture-specific temporary folder.\n${err}`)
    }

    // Initialize intercepter (proxy)
    await this.intercepter.setup()

    // Playwright init + pass proxy info to Chromium
    const userAgent = chromium._playwright.devices['Desktop Chrome'].userAgent + options.userAgentSuffix
    this.provenanceInfo.userAgent = userAgent
    this.log.info(`User Agent used for capture: ${userAgent}`)

    this.#browser = await chromium.launch({
      headless: options.headless,
      chromiumSandbox: options.chromiumSandbox
    })

    const context = await this.#browser.newContext({
      ...this.intercepter.contextOptions,
      ...(multipageState(this) ? { serviceWorkers: 'block' } : {}),
      userAgent,
      // NOTE:
      // This is a temporary workaround.
      // Most browsers now accept zstd, but part of the web archiving stack (indexing, playback ...) is not fully ready to handle it yet.
      // This line wants to be removed once the ecosystem is ready for zstd.
      // More on zstd: https://datatracker.ietf.org/doc/html/rfc8878
      // TODO: Remove whenever possible.
      extraHTTPHeaders: {
        'Accept-Encoding': 'gzip, compress, deflate, br'
      }
    })

    this.#context = context
    this.#unobserveTls = this.#tls.observe(context)
    if (multipageState(this)) {
      context.on('page', page => {
        const run = this.#activeRun
        if (!run || !run.active || this.#recordingStop) {
          const closing = page.close().catch(() => { this.#sessionFailed = true })
            .finally(() => this.#closingPages.delete(closing))
          this.#closingPages.add(closing)
          return
        }
        run.pages.add(page)
        // A popup may make its first request before this event is delivered.
        context.newCDPSession(page).then(async session => {
          await session.send('Network.setCacheDisabled', { cacheDisabled: true })
        }).catch(() => {})
      })
    }
    const page = multipageState(this) ? null : await context.newPage()

    await page?.setViewportSize({
      width: options.captureWindowX,
      height: options.captureWindowY
    })

    // Enforce capture timeout
    this.#deadline = performance.now() + options.captureTimeout
    const captureTimeoutTimer = this.#captureTimer = setTimeout(() => {
      this.log.info(`captureTimeout of ${options.captureTimeout}ms reached. Ending further capture.`)
      this.stopRecording('capture_timeout')
    }, options.captureTimeout)

    this.#browser.on('disconnected', () => {
      this.#sessionFailed = true
      this.#assessment?.abort()
      clearTimeout(captureTimeoutTimer)
    })

    return page
  }

  /**
   * Tears down Playwright, intercepter, and capture-specific temporary folder.
   * @returns {Promise<void>}
   */
  async teardown () {
    this.log.info('Closing browser and intercepter')
    await this.intercepter.teardown()
    await this.#browser?.close()
    this.#unobserveTls?.()

    this.exchanges = this.intercepter.exchanges.concat(this.exchanges)

    this.log.info(`Clearing capture-specific temporary folder ${this.captureTmpFolderPath}`)
    await this.#removeScratchDirectory()
  }

  /**
   * Assesses whether `this.url` leads to a non-web resource and, if so:
   * - Captures it via a curl behind our proxy
   * - Sets capture state to `PARTIAL`
   *
   * Populates `this.targetUrlIsWebPage` and `this.targetUrlContentType`.
   *
   * @param {Page} page - A Playwright [Page]{@link https://playwright.dev/docs/api/class-page} object
   * @returns {Promise<void>}
   * @private
   */
  async #detectAndCaptureNonWebContent (page, run = this) {
    /** @type {?string} */
    let contentType = null

    /** @type {?number} */
    let contentLength = null

    /** @type {?number} */
    let status = null

    /**
     * Time spent on the initial HEAD request, in ms.
     * @type {?number}
     */
    let headRequestTimeMs = null

    /** Whether the HEAD request was given up on because its own time ran out. */
    let headRequestTimedOut = false

    //
    // Is `run.url` leading to a text/html resource?
    //
    try {
      const before = new Date()

      // Timeout = a 10th of captureTimeout if >= 1 second, 1 second otherwise.
      let timeout = this.options.captureTimeout / 10

      if (timeout < 1000) {
        timeout = 1000
      }

      timeout = this.#remaining(timeout)
      const controller = new AbortController()
      const timeoutId = setTimeout(() => { headRequestTimedOut = true; controller.abort() }, timeout)
      const policy = new NetworkPolicy(this.options.blocklist, (match, rule) => {
        this.provenanceInfo.blockedRequests.push({ match, rule })
      })

      let headRequest
      try {
        headRequest = await fetchHead(run.url, policy, { signal: run === this ? controller.signal : AbortSignal.any([controller.signal, run.stepController.signal]) })
      } finally {
        clearTimeout(timeoutId)
        policy.close()
      }

      const after = new Date()

      headRequestTimeMs = after - before

      run.targetUrlResolved = headRequest.url
      status = headRequest.status
      contentType = headRequest.headers.get('Content-Type')
      contentLength = headRequest.headers.get('Content-Length')
    } catch (err) {
      if (this.#tls.record(err, { run, target: run.url, phase: 'head', primary: true })) throw err
      this.log.trace(err)
      this.log.warn('Resource type detection failed - skipping')
      if (run === this) return
      // Array mode records that the step failed, and why. The visit goes on to the browser as before.
      if (err?.code === 'ERR_NETWORK_POLICY') {
        this.#tls.block(run)
        throw new StepFailure('network_policy_blocked', { cause: err })
      }
      throw new StepFailure(headRequestTimedOut ? 'step_timeout' : 'step_failed', { cause: err })
    }

    // A HEAD request that fails says nothing about what the browser's GET will
    // receive: some servers refuse HEAD (405) with an error body of another
    // content type, e.g. JSON, while serving the page itself as HTML.
    if (status < 200 || status >= 300) {
      this.log.info(`Requested URL is assumed to be a web page (HEAD request returned ${status})`)
      return
    }

    // Capture content-type
    if (contentType) {
      run.targetUrlContentType = contentType
    }

    // If text/html or no content-type, bail from non-web content capture process.
    // Scoop.capture will go based on the value of `run.targetUrlIsWebPage`.
    if (!contentType) {
      this.log.info('Requested URL is assumed to be a web page (no content-type found)')
      return
    }

    if (contentType?.startsWith('text/html')) {
      this.log.info('Requested URL is a web page')
      return
    }

    run.targetUrlIsWebPage = false
    this.log.warn(`Requested URL is not a web page (detected: ${contentType})`)
    this.log.info('Scoop will attempt to capture this resource out-of-browser')

    //
    // Check if curl is present
    //
    try {
      await exec('curl', ['--disable', '-V'], run === this ? {} : { timeout: this.#remaining(3000), signal: run.stepController.signal })
    } catch (err) {
      this.log.trace(err)
      this.log.warn('curl is not present on this system - skipping')
      return
    }

    //
    // Capture using curl behind proxy
    //
    try {
      const userAgent = this.provenanceInfo.userAgent

      let timeout = this.options.captureTimeout - headRequestTimeMs

      if (timeout < 1000) {
        timeout = 1000
      }

      timeout = this.#remaining(timeout)
      const curlOptions = [
        '--disable', '--globoff', '--proto', '=http,https', '--proto-redir', '=http,https',
        '--noproxy', '', '--url', run.url,
        '--header', `User-Agent: ${userAgent}`,
        '--output', '/dev/null',
        '--proxy', `http://${this.options.proxyHost}:${this.options.proxyPort}`,
        '--insecure', // Trust the local MITM; the proxy verifies the origin.
        '--location',
        // This will be the only capture step running:
        // use all available time - time spent on first request
        '--max-time', String(run === this ? Math.floor(timeout / 1000) : timeout / 1000)
      ]

      this.#tls.helper(run, true)
      try {
        await exec('curl', curlOptions, { timeout, ...(run === this ? {} : { signal: run.stepController.signal }) })
      } finally {
        this.#tls.helper(run, false)
      }
      if (run !== this) run.helperFinished = !this.#recordingStop
    } catch (err) {
      this.log.trace(err)
    }

    //
    // Report on results and:
    // - Set capture state to PARTIAL if _anything_ was captured.
    // - Leave capture state to CAPTURE otherwise.
    //
    if (this.#tls.failed(run)) throw this.#tls.failed(run)
    const observed = this.intercepter.exchanges.slice(run === this ? 0 : run.exchangeStart)
    if (observed.length > 0) {
      const intercepted = observed[0]?.response?.body?.byteLength

      if (intercepted === Number(contentLength)) {
        this.log.info(`Resource fully captured (${contentLength} bytes)`)
      } else {
        this.log.warn(`Resource partially captured (${intercepted} of ${contentLength} bytes)`)
      }

      run.state = Scoop.states.PARTIAL
      if (run !== this) run.reason = this.#recordingStop || 'non_web_capture'
    } else {
      this.log.warn('Resource could not be captured')
      if (run !== this) throw new StepFailure('step_failed')
    }
  }

  /**
   * Tries to populate `this.pageInfo`.
   * Captures page title, description, url and favicon url directly from the browser.
   * Will attempt to find the favicon in intercepted exchanges if running in headfull mode, and request it out-of-band otherwise.
   *
   * @param {Page} page - A Playwright [Page]{@link https://playwright.dev/docs/api/class-page} object
   * @returns {Promise<void>}
   * @private
   */
  async #capturePageInfo (page, run = this) {
    run.pageInfo = await page.evaluate(() => {
      return {
        title: document.title,
        description: document.querySelector("meta[name='description']")?.content,
        url: window.location.href,
        faviconUrl: document.querySelector("link[rel*='icon']")?.href,
        favicon: null
      }
    })

    //
    // Favicon processing
    //

    // Not needed if:
    // - No favicon URL found
    // - Favicon url is not an http(s) URL
    if (!run.pageInfo?.faviconUrl) {
      return
    }

    if (!['http:', 'https:'].includes(new URL(run.pageInfo.faviconUrl).protocol)) {
      return
    }

    // If `headless`: request the favicon using curl so it's added to the exchanges list.
    if (this.options.headless) {
      try {
        const userAgent = this.provenanceInfo.userAgent

        const timeout = 1000

        const curlOptions = [
          '--disable', '--globoff', '--proto', '=http,https', '--proto-redir', '=http,https',
          '--noproxy', '', '--url', run.pageInfo.faviconUrl,
          '--header', `User-Agent: ${userAgent}`,
          '--output', '/dev/null',
          '--proxy', `http://${this.options.proxyHost}:${this.options.proxyPort}`,
          '--insecure', // Trust the local MITM; the proxy verifies the origin.
          '--max-time', String(Math.floor(timeout / 1000))
        ]

        await exec('curl', curlOptions, { timeout, ...(run === this ? {} : { signal: run.stepController.signal }) })
      } catch (err) {
        this.log.warn(`Could not fetch favicon at url ${run.pageInfo.faviconUrl}.`)
        this.log.trace(err)
      }
    }

    // Look for favicon in exchanges
    for (const exchange of this.intercepter.exchanges.slice(run === this ? 0 : run.exchangeStart)) {
      if (exchange?.url && exchange.url === run.pageInfo.faviconUrl && exchange?.response?.body) {
        run.pageInfo.favicon = exchange.response.body
      }
    }
  }

  /**
   * Runs `yt-dlp` on the current url to try and capture:
   * - The "main" video(s) of the current page (`file:///video-extracted-x.mp4`)
   * - Associated subtitles (`file:///video-extracted-x.LOCALE.vtt`)
   * - Associated meta data (`file:///video-extracted-metadata.json`)
   *
   * These elements are added as "attachments" to the archive, for context / playback fallback purposes.
   * A summary file and entry point, `file:///video-extracted-summary.html`, will be generated in the process.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #captureVideoAsAttachment (run = this) {
    const recordingBefore = this.intercepter.recordExchanges
    const videoFilename = `${run.captureTmpFolderPath}video-extracted-%(autonumber)d.mp4`
    const ytDlpPath = this.options.ytDlpPath
    const ytDlpEnvironment = omitEnvironmentVariables(process.env, ['no_proxy', 'NO_PROXY'])

    let metadataRaw = null
    let metadataParsed = null

    let videoSaved = false
    let metadataSaved = false
    let subtitlesSaved = false

    /**
     * Key: video filename (ex: "video-extracted-1").
     * Value: array of subtitle locales (ex: ["en-US", "fr-FR"])
     * @type {Object<string, string[]>}
     */
    const availableVideosAndSubtitles = {}

    //
    // yt-dlp health check
    //
    try {
      const version = await exec(ytDlpPath, ['--ignore-config', '--version'], {
        env: ytDlpEnvironment,
        ...(run === this ? {} : { timeout: this.options.captureVideoAsAttachmentTimeout }),
        ...(run === this ? {} : { signal: run.stepController.signal })
      }).then((v) => v.trim())

      if (!version.match(/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$/)) {
        throw new Error(`Unknown version: ${version}`)
      }
    } catch (err) {
      this.log.trace(err)
      throw new Error('"yt-dlp" executable is not available or cannot be executed.')
    }

    //
    // Try and pull video(s) and meta data from url
    //
    try {
      this.intercepter.recordExchanges = false

      const dlpOptions = [
        '--ignore-config',
        '--dump-json', // Will return JSON meta data via stdout
        '--no-simulate', // Forces download despite `--dump-json`
        '--no-warnings', // Prevents pollution of stdout
        '--no-progress', // (Same as above)
        '--write-subs', // Try to pull subs
        '--sub-langs', 'all',
        '--format', 'mp4', // Forces .mp4 format
        '--output', videoFilename,
        '--no-check-certificate',
        '--proxy', `http://${this.options.proxyHost}:${this.options.proxyPort}`,
        '--max-filesize', String(this.options.maxVideoCaptureSize),
        '--', run.url
      ]

      const spawnOptions = {
        timeout: this.options.captureVideoAsAttachmentTimeout,
        maxBuffer: 1024 * 1024 * 128,
        env: ytDlpEnvironment,
        ...(run === this ? {} : { signal: run.stepController.signal })
      }

      metadataRaw = await exec(ytDlpPath, dlpOptions, spawnOptions)
    } catch (err) {
      this.log.trace(err)
      throw new Error(`No video found in ${run.url}.`)
    } finally {
      this.intercepter.recordExchanges = run === this ? true : !this.#recordingStop && run.active && recordingBefore
    }

    //
    // Add available video(s) and subtitles to exchanges
    //
    for (const file of await readdir(run.captureTmpFolderPath)) {
      // Video
      if (file.startsWith('video-extracted-') && file.endsWith('.mp4')) {
        try {
          const url = `file:///${file}`
          const httpHeaders = new Headers({ 'content-type': 'video/mp4' })
          const body = await readArtifactFile(`${run.captureTmpFolderPath}${file}`)
          const isEntryPoint = false // TODO: Reconsider whether this should be an entry point.

          if (!body.length) {
            continue
          }
          this.addGeneratedExchange(url, httpHeaders, body, isEntryPoint, '', run)
          videoSaved = true

          // Push to map of available videos and subtitles
          const index = (run === this ? '' : run.prefix) + file.replace('.mp4', '')

          if (!(index in availableVideosAndSubtitles)) {
            availableVideosAndSubtitles[index] = []
          }
        } catch (err) {
          this.log.warn(`Error while creating exchange for ${file}.`)
          this.log.trace(err)
        }
      }

      // Subtitles
      if (file.startsWith('video-extracted-') && file.endsWith('.vtt')) {
        try {
          const url = `file:///${file}`
          const httpHeaders = new Headers({ 'content-type': 'text/vtt' })
          const body = await readArtifactFile(`${run.captureTmpFolderPath}${file}`)
          const isEntryPoint = false
          const locale = file.split('.')[1]

          // Example of valid locales: "en", "en-US"
          if (!locale.match(/^[a-z]{2}$/) && !locale.match(/[a-z]{2}-[A-Z]{2}/)) {
            continue
          }

          this.addGeneratedExchange(url, httpHeaders, body, isEntryPoint, '', run)
          subtitlesSaved = true

          // Push to map of available videos and subtitles
          const index = (run === this ? '' : run.prefix) + file.replace('.vtt', '').replace(`.${locale}`, '')

          if (!(index in availableVideosAndSubtitles)) {
            availableVideosAndSubtitles[index] = []
          }

          availableVideosAndSubtitles[index].push(locale)
        } catch (err) {
          this.log.warn(`Error while creating exchange for ${file}.`)
          this.log.trace(err)
        }
      }
    }

    if (videoSaved === false) {
      this.log.warn('yt-dlp reported success (returned 0), but produced no output.')
      return
    }

    //
    // Try to add metadata to exchanges
    //
    try {
      metadataParsed = []

      // yt-dlp returns JSONL when there is more than 1 video
      for (const line of metadataRaw.split('\n')) {
        if (line) {
          metadataParsed.push(JSON.parse(line)) // May throw
        }
      }

      if (!metadataParsed.length) {
        throw new Error('yt-dlp reported success (returned 0) but produced no metadata.')
      }

      // Merge parsed metadata into a single JSON string and clean it before saving it
      const metadataAsJSON = JSON
        .stringify(metadataParsed, null, 2)
        .replaceAll(run.captureTmpFolderPath, '')

      const url = 'file:///video-extracted-metadata.json'
      const httpHeaders = new Headers({ 'content-type': 'application/json' })
      const body = Buffer.from(metadataAsJSON)
      const isEntryPoint = false

      this.addGeneratedExchange(url, httpHeaders, body, isEntryPoint, '', run)
      metadataSaved = true
    } catch (err) {
      this.log.warn('Error while creating exchange for file:///video-extracted-medatadata.json.')
      this.log.trace(err)
    }

    //
    // Generate summary page
    //
    try {
      const html = nunjucks.render('video-extracted-summary.njk', {
        url: run.url,
        now: new Date().toISOString(),
        videoSaved,
        metadataSaved,
        metadataFilename: run === this ? 'video-extracted-metadata.json' : `${run.prefix}video-extracted-metadata.json`,
        subtitlesSaved,
        availableVideosAndSubtitles,
        metadataParsed: metadataParsed.map(entry => {
          const date = typeof entry.timestamp === 'number' ? new Date(entry.timestamp * 1000) : null
          return { ...entry, publicationTime: date && Number.isFinite(date.getTime()) ? date.toISOString() : '' }
        })
      })

      const url = 'file:///video-extracted-summary.html'
      const httpHeaders = new Headers({ 'content-type': 'text/html' })
      const body = Buffer.from(html)
      const isEntryPoint = true
      const description = `Extracted Video data from: ${run.url}`

      this.addGeneratedExchange(url, httpHeaders, body, isEntryPoint, description, run)
    } catch (err) {
      this.log.warn('Error while creating exchange for file:///video-extracted-summary.html.')
      this.log.trace(err)
    }
  }

  /** Bound browser snapshot work while preserving completed capture artifacts. */
  async #browserSnapshot (operation, name, run = this) {
    return await withSnapshotDeadline(operation, async () => {
      this.#browserClosedAfterSnapshotTimeout = true
      run.state = Scoop.states.PARTIAL
      if (run !== this) run.reason = this.#recordingStop || 'snapshot_timeout'
      this.log.warn(`${name} snapshot exceeded 10 seconds; closing browser and preserving the partial capture.`)
      await this.#browser.close()
    })
  }

  /**
   * Bound a snapshot of one page of an array capture. Past its deadline the visit to that
   * page fails with `snapshot_timeout`, its page is closed, and the session goes on: the
   * browser and its context are left to the pages that follow.
   *
   * Closing the page is what ends the work it was doing, and is itself bounded. A page that
   * does not close is a failure of the shared session, which then stops.
   */
  async #pageSnapshot (operation, name, run, page) {
    return await withSnapshotDeadline(operation, async () => {
      // A stop of the whole capture that came first remains the cause.
      if (!this.#recordingStop) {
        run.state = Scoop.states.FAILED
        run.reason = 'snapshot_timeout'
      }
      run.terminal = true
      this.log.warn(`[${run.id}] ${name} snapshot exceeded 10 seconds; closing its page and moving on.`)
      if (!await this.#closePage(page)) {
        this.#sessionFailed = true
        this.log.error(`[${run.id}] The page did not close after its ${name} snapshot timed out. Ending the session.`)
      }
    })
  }

  /**
   * Tries to generate a PDF snapshot from Playwright and add it as a generated exchange (`file:///pdf-snapshot.pdf`).
   * Dimensions of the PDF are based on current document width and height.
   *
   * @param {Page} page - A Playwright [Page]{@link https://playwright.dev/docs/api/class-page} object
   * @returns {Promise<void>}
   */
  async #takePdfSnapshot (page, run = this) {
    let pdf = null
    let dimensions = null

    await page.emulateMedia({ media: 'screen' })

    // Pull dimensions from live browser
    dimensions = await page.evaluate(() => {
      const width = Math.max(document.body.scrollWidth, window.outerWidth)
      const height = Math.max(document.body.scrollHeight, window.outerHeight) + 50
      return { width, height }
    })

    // Generate PDF
    pdf = await page.pdf({
      printBackground: true,
      width: dimensions.width,
      height: dimensions.height
    })

    const url = 'file:///pdf-snapshot.pdf'
    const httpHeaders = new Headers({ 'content-type': 'application/pdf' })
    const body = pdf
    const isEntryPoint = true
    const description = `Capture Time PDF Snapshot of ${run.url}`

    this.#addArtifact(url, httpHeaders, body, isEntryPoint, description, run)
  }

  /**
   * Runs `crip` against the different origins the capture process encountered.
   * Captures certificates as `file:///[origin].pem`).
   * Populates `this.provenanceInfo.certificates`.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #captureCertificatesAsAttachment () {
    const { captureCertificatesAsAttachmentTimeout, cripPath } = this.options

    //
    // Check that `crip` is available
    //
    try {
      await exec(cripPath)
    } catch (err) {
      this.log.trace(err)
      throw new Error('"crip" executable is not available or cannot be executed.')
    }

    //
    // Pull certs: each host once, all within the step's one time budget.
    //
    const urls = this.intercepter.exchanges.map(exchange => exchange.url)

    try {
      await forEachHttpsHostWithinBudget(urls, captureCertificatesAsAttachmentTimeout, async (host, remainingMs) => {
        if (this.blocklist.find(searchBlocklistFor(`https://${host}`))) {
          this.log.warn(`${host} matched against blocklist - skipped trying to pull its certificate.`)
          return
        }

        const tunnel = await createCertificateTunnel(this.intercepter.networkPolicy)
        let pem
        try {
          pem = await exec(cripPath, [
            'print',
            '-u', `https://${host}`,
            '-f', 'pem',
            '--proxy-host', tunnel.host,
            '--proxy-port', String(tunnel.port)
          ], {
            timeout: remainingMs,
            // exec waits for the process to exit before it gives up, so a
            // call must not be able to outlive its timeout by ignoring SIGTERM.
            killSignal: 'SIGKILL',
            maxBuffer: 1024 * 1024 * 128
          })
        } finally {
          await tunnel.close()
        }

        if (!pem) {
          throw new Error(`crip did not return a PEM for ${host}.`)
        }

        // Add to generated exchanges
        const fileUrl = `file:///${host}.pem`
        const httpHeaders = new Headers({ 'content-type': 'application/x-pem-file' })
        const body = Buffer.from(pem)
        const isEntryPoint = false
        await this.addGeneratedExchange(fileUrl, httpHeaders, body, isEntryPoint)

        // Add to `this.provenanceInfo.certificates`
        this.provenanceInfo.certificates.push({ host, pem })
      }, {
        onError: (host, err) => {
          this.log.trace(err)
          this.log.warn(`Certificates could not be extracted for ${host}`)
        }
      })
    } catch (err) {
      // The only thing the loop above rejects with is its time budget running out.
      throw new StepFailure('step_timeout', { cause: err }, 'Capture certificates at attachment timeout reached')
    }
  }

  /**
   * The clip for a full-page screenshot, from `screenshotMaxWidth` and
   * `screenshotMaxHeight`: the top-left of the page, up to those sizes.
   *
   * Playwright trims a full-page clip to the page's own size, so a smaller page
   * is captured whole, and Chromium renders only the clipped area. Unbounded,
   * a very tall page can take the browser gigabytes of memory to render.
   *
   * @returns {{clip?: {x: number, y: number, width: number, height: number}}}
   * @private
   */
  #screenshotClip () {
    const { screenshotMaxWidth, screenshotMaxHeight } = this.options

    if (!screenshotMaxWidth && !screenshotMaxHeight) {
      return {}
    }

    return {
      clip: {
        x: 0,
        y: 0,
        width: screenshotMaxWidth || Number.MAX_SAFE_INTEGER,
        height: screenshotMaxHeight || Number.MAX_SAFE_INTEGER
      }
    }
  }

  /**
   * Populates `this.provenanceInfo`, which is then used to generate a `file:///provenance-summary.html` exchange and entry point.
   * That property is also be used by `scoopToWACZ()` to populate the `extras` field of `datapackage.json`.
   *
   * Provenance info collected:
   * - Capture client IP, resolved using the endpoint provided in the `publicIpResolverEndpoint` option.
   * - Operating system details (type, name, major version, CPU architecture)
   * - Scoop version
   * - Scoop options object used during capture
   *
   * @param {Page} page - A Playwright [Page]{@link https://playwright.dev/docs/api/class-page} object
   * @private
   */
  async #captureProvenanceInfo (page) {
    let captureIp = 'UNKNOWN'
    // Null when the OS cannot be identified; the summary then has no name.
    const osInfo = await getOSInfo()
    let ytDlpHash = ''
    let cripHash = ''

    // Grab public IP address - uses CURL
    try {
      const response = await exec('curl', [
        '--disable', '--globoff', '--proto', '=http,https',
        '--url', this.options.publicIpResolverEndpoint,
        '--max-time', '3'
      ])

      const ip = response.trim()

      try {
        new Address4(ip) // eslint-disable-line
      } catch {
        try {
          new Address6(ip) // eslint-disable-line
        } catch {
          throw new Error(`${ip} is not a valid IP address.`)
        }
      }

      captureIp = ip
    } catch (err) {
      this.log.warn('Public IP address could not be found.')
      this.log.trace(err)
    }

    // Compute yt-dlp hash
    try {
      ytDlpHash = createHash('sha256')
        .update(await readFile(this.options.ytDlpPath))
        .digest('hex')

      ytDlpHash = `sha256:${ytDlpHash}`
    } catch (err) {
      this.log.warn('Could not compute SHA256 hash of yt-dlp executable')
      this.log.trace(err)
    }

    // Compute crip hash
    try {
      cripHash = createHash('sha256')
        .update(await readFile(this.options.cripPath))
        .digest('hex')

      cripHash = `sha256:${cripHash}`
    } catch (err) {
      this.log.warn('Could not compute SHA256 hash of crip executable')
      this.log.trace(err)
    }

    // Gather provenance info
    this.provenanceInfo = {
      ...this.provenanceInfo,
      captureIp,
      software: CONSTANTS.SOFTWARE,
      version: CONSTANTS.VERSION,
      osType: os.type(),
      osName: osInfo?.name ?? null,
      osVersion: osInfo?.version ?? null,
      cpuArchitecture: os.machine(),
      ytDlpHash,
      cripHash,
      options: structuredClone(this.options)
    }

    // ytDlpPath and cripPath should be excluded from provenance summary
    delete this.provenanceInfo.options.ytDlpPath
    delete this.provenanceInfo.options.cripPath

    if (multipageState(this)) this.provenanceInfo.multipage = this.multipage

    // Generate summary page
    try {
      const html = nunjucks.render('provenance-summary.njk', {
        ...this.provenanceInfo,
        date: this.startedAt.toISOString(),
        url: this.url
      })

      const url = 'file:///provenance-summary.html'
      const httpHeaders = new Headers({ 'content-type': 'text/html' })
      const body = Buffer.from(html)
      const isEntryPoint = true
      const description = 'Provenance Summary'

      this.addGeneratedExchange(url, httpHeaders, body, isEntryPoint, description)
    } catch (err) {
      throw new Error(`Error while creating exchange for file:///provenance-summary.html. ${err}`)
    }
  }

  /**
   * Generates a ScoopGeneratedExchange for generated content and adds it to `exchanges`.
   *
   * @param {string} url
   * @param {Headers} headers
   * @param {Buffer} body
   * @param {boolean} [isEntryPoint=false]
   * @param {string} [description='']
   * @param {object} [run] - In array mode, the visit that generated it: `id` is its page, `url` the requested URL and `attemptNumber` the visit, from 1. The exchange added, last of `exchanges` when this returns true, carries them as `pageId`, `sourceUrl` and `attemptNumber`, and is named after them: `page-0001-screenshot.png`, then `page-0001-attempt-2-screenshot.png`.
   * @returns {boolean} true if generated exchange is successfully added
   */
  addGeneratedExchange (url, headers, body, isEntryPoint = false, description = '', run = this) {
    if (this.#tls.failed(run)) return false
    if (multipageState(this)) {
      if (run !== this && !run.active) return false
      if (!this.options.attachmentsBypassLimits &&
        ((run === this ? this.#activeRun?.state : run.state) !== Scoop.states.CAPTURE ||
          this.intercepter.byteLength + this.#generatedBytes + body.byteLength >= this.options.maxCaptureSize)) {
        this.stopRecording('capture_size_limit')
        return false
      }
      if (run !== this && run.id) url = `file:///${run.prefix ?? artifactPrefix(run.id)}${url.slice(8)}`
      this.#generatedBytes += body.byteLength
    } else {
      // Check maxCaptureSize and capture state unless `attachmentsBypassLimits` flag was raised.
      if (this.options.attachmentsBypassLimits === false) {
        const remainingSpace = this.options.maxCaptureSize - this.intercepter.byteLength

        if (this.state !== Scoop.states.CAPTURE || body.byteLength >= remainingSpace) {
          this.state = Scoop.states.PARTIAL
          this.log.warn(`Generated exchange ${url} could not be saved (size limit reached).`)
          return false
        }
      }
    }

    this.exchanges.push(
      new ScoopGeneratedExchange({
        url,
        ...(run !== this && run.id ? { pageId: run.id, sourceUrl: run.url, attemptNumber: run.attemptNumber ?? 1 } : {}),
        description,
        isEntryPoint: Boolean(isEntryPoint),
        response: {
          startLine: 'HTTP/1.1 200 OK',
          headers,
          body
        }
      })
    )

    return true
  }

  /**
   * Filters a url to ensure it's suitable for capture.
   * This function throws if:
   * - `url` is not a valid url
   * - `url` is not an http / https url
   * - `url` matches a blocklist rule
   *
   * @param {string} url
   */
  filterUrl (url) {
    let pass = true

    // Is the url "valid"? (format)
    try {
      const filteredUrl = new URL(url) // Will throw if not a valid url

      if (filteredUrl.protocol !== 'https:' && filteredUrl.protocol !== 'http:') {
        this.log.error('Invalid protocol.')
        pass = false
      }

      url = filteredUrl.href
    } catch (err) {
      this.log.error(`Invalid url provided.\n${err}`)
      pass = false
    }

    // If the url part of the blocklist?
    const rule = this.blocklist.find(searchBlocklistFor(url))
    if (rule) {
      this.log.error(`Blocked url provided matching blocklist rule: ${rule}`)
      pass = false
    }

    if (!pass) {
      throw new Error('Invalid URL provided.')
    }

    return url
  }

  /**
   * Returns a map of "generated" exchanges.
   * Generated exchanges = anything generated directly by Scoop (PDF snapshot, full-page screenshot, videos ...) as opposed to naturally intercepted.
   * @returns {Object.<string, ScoopGeneratedExchange>}
   */
  extractGeneratedExchanges () {
    if (![Scoop.states.COMPLETE, Scoop.states.PARTIAL].includes(this.state)) {
      throw new Error('Cannot export generated exchanges on a pending or failed capture.')
    }

    const generatedExchanges = {}

    for (const exchange of this.exchanges) {
      if (exchange instanceof ScoopGeneratedExchange) {
        const key = exchange.url.replace('file:///', '')
        generatedExchanges[key] = exchange
      }
    }

    return generatedExchanges
  }

  /**
   * (Shortcut) Reconstructs a Scoop capture from a WACZ.
   * @param {string} zipPath - Path to .wacz file.
   * @returns {Promise<Scoop>}
   */
  static async fromWACZ (zipPath) {
    return await importers.WACZToScoop(zipPath)
  }

  /**
   * (Shortcut) Export this Scoop capture to WARC.
   * @param {boolean} [gzip=false]
   * @returns {Promise<ArrayBuffer>}
   */
  async toWARC (gzip = false) {
    return await exporters.scoopToWARC(this, Boolean(gzip))
  }

  /**
   * (Shortcut) Export this Scoop capture to WACZ.
   * @param {boolean} [includeRaw=true] - Include a copy of RAW HTTP exchanges to the wacz (under `/raw`)?
   * @param {object} signingServer - Optional server information for signing the WACZ
   * @param {string} signingServer.url - url of the signing server
   * @param {string} signingServer.token - Optional token to be passed to the signing server via the Authorization header
   * @returns {Promise<ArrayBuffer>}
   */
  async toWACZ (includeRaw = true, signingServer) {
    return await exporters.scoopToWACZ(this, includeRaw, signingServer)
  }

  /**
   * @typedef {Object} ScoopCaptureSummary
   * @property {int} state
   * @property {string[]} states - Zero-indexed Scoop.states values.
   * @property {string} targetUrl
   * @property {boolean} targetUrlIsWebPage
   * @property {string} targetUrlContentType
   * @property {ScoopOptions} options
   * @property {string} startedAt - ISO-formatted date
   * @property {object} attachments - Summary of generated exchange filenames.
   * @property {?string} attachments.provenanceSummary - Filename
   * @property {?string} attachments.screenshot - Filename
   * @property {?string} attachments.pdfSnapshot - Filename
   * @property {?string} attachments.domSnapshot - Filename
   * @property {?string} attachments.videoExtractedSummary - Filename
   * @property {?string} attachments.videoExtractedMetadata - Filename
   * @property {?string[]} attachments.videoExtracted - Filenames
   * @property {?string[]} attachments.videoExtractedSubtitles - Filenames
   * @property {?string[]} attachments.certificates - Filenames
   * @property {?object} provenanceInfo - See {@link Scoop.provenanceInfo}. Only populated if the "provenanceSummary" option was turned on.
   * @property {ScoopCaptureError[]} errors - Structured TLS failures, independent of provenance.
   * @property {object[]} steps - See {@link Scoop.steps}.
   */

  /**
   * Generates and returns a summary of the current capture, regardless of its state.
   * @returns {Promise<ScoopCaptureSummary>}
   */
  async summary () {
    if (multipageState(this)) {
      const inventory = this.multipage
      const first = inventory.pages[0]
      const provenanceInfo = this.options.provenanceSummary ? structuredClone(this.provenanceInfo) : {}
      if (this.options.provenanceSummary && provenanceInfo.multipage) provenanceInfo.multipage = inventory
      return {
        state: this.state,
        errors: this.errors,
        states: Object.keys(Scoop.states),
        targetUrl: this.url,
        targetUrlResolved: first.resolvedUrl || this.url,
        targetUrlIsWebPage: this.targetUrlIsWebPage,
        targetUrlContentType: this.targetUrlContentType,
        startedAt: this.startedAt,
        options: structuredClone(this.options),
        exchangeUrls: this.exchanges.map(exchange => exchange.url),
        attachments: { ...first.attachments, ...artifactSummary(this.exchanges, null) },
        provenanceInfo,
        pageInfo: first.pageInfo,
        steps: structuredClone(this.steps),
        multipage: inventory
      }
    }
    const summary = {
      state: this.state,
      errors: this.errors,
      states: Object.keys(Scoop.states), // So summary.states[summary.state] = 'NAME-OF-STATE'
      targetUrl: this.url,
      targetUrlResolved: this.targetUrlResolved,
      targetUrlIsWebPage: this.targetUrlIsWebPage,
      targetUrlContentType: this.targetUrlContentType,
      startedAt: this.startedAt,
      options: this.options,
      exchangeUrls: this.exchanges.map(exchange => exchange.url),
      attachments: {},
      provenanceInfo: this.options.provenanceSummary ? this.provenanceInfo : {},
      pageInfo: this.pageInfo,
      steps: this.steps
      // NOTE:
      // `provenanceInfo` also contains an `options` object,
      // but some of its properties have been edited because it is meant to be embedded in a WACZ.
      // (For example: Paths replaced with hashes)
      // For that reason, it is worth keeping both `options` objects,
      // because `provenanceInfo.options` is both different and contextual.
    }

    // Remove favicon from pageInfo
    if (summary.pageInfo && 'favicon' in summary.pageInfo) {
      delete summary.pageInfo.favicon
    }

    //
    // Summarize attachments
    //
    // A failed capture has no attachments to offer: its exchanges are not
    // exportable. Its summary still reports how far it got.
    const generatedExchanges = [Scoop.states.COMPLETE, Scoop.states.PARTIAL].includes(this.state)
      ? this.extractGeneratedExchanges()
      : {}

    // 1-to-1 matches:
    // - Add filename to "attachments" as key if present in generated exchanges list
    // - Example: attachments.provenanceSummary = "provenance-summary.html"
    for (const [key, filename] of Object.entries({
      provenanceSummary: 'provenance-summary.html',
      screenshot: 'screenshot.png',
      pdfSnapshot: 'pdf-snapshot.pdf',
      domSnapshot: 'dom-snapshot.html',
      videoExtractedSummary: 'video-extracted-summary.html',
      videoExtractedMetadata: 'video-extracted-metadata.json'
    })) {
      if (generatedExchanges[filename]) {
        summary.attachments[key] = filename
      }
    }

    // 1-to-many matches:
    // - Videos are added to attachments.videoExtracted[]
    // - Video subtitles are added to attachments.videoSubtitles[]
    // - SSL certs are added to attachments.certificates[]
    for (const filename of Object.keys(generatedExchanges)) {
      if (filename.endsWith('.mp4')) {
        if (!summary.attachments?.videos) {
          summary.attachments.videoExtracted = []
        }
        summary.attachments.videoExtracted.push(filename)
      }

      if (filename.endsWith('.vtt')) {
        if (!summary.attachments?.videoSubtitles) {
          summary.attachments.videoExtractedSubtitles = []
        }
        summary.attachments.videoExtractedSubtitles.push(filename)
      }

      if (filename.endsWith('.pem')) {
        if (!summary.attachments?.certificates) {
          summary.attachments.certificates = []
        }
        summary.attachments.certificates.push(filename)
      }
    }

    return summary
  }
}
