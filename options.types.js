/**
 * Available options and defaults for Scoop.
 * @typedef {Object} ScoopOptions
 * @property {("silent" | "trace" | "debug" | "info" | "warn" | "error")} logLevel="info" - Determines the logging level of this instance. See {@link https://github.com/pimterry/loglevel} for more information.
 *
 * @property {boolean} deduplicatePayloads=false - Strict boolean; deduplicate eligible identical WARC payloads during export only. Does not reduce network traffic, received-byte accounting or raw storage.
 * @property {boolean} screenshot=true - Should Scoop try to make a screenshot? Screenshot will be added as `file:///screenshot.png` in the exchanges list.
 * @property {boolean} pdfSnapshot=false - Should Scoop save a PDF of the rendered page? Only available in headless mode. Added as `file:///pdf-snapshot.pdf` in the exchanges list.
 * @property {boolean} domSnapshot=false - Should Scoop save a snapshot of the rendered DOM? Added as `file:///dom-snapshot.html` in the exchanges list.
 * @property {boolean} captureVideoAsAttachment=true - Should Scoop try to save the main video(s) present on this page? Added as `file://` attachments, summarized under `file:///video-extracted-summary.html`. This capture happens out of the browser.
 * @property {boolean} captureCertificatesAsAttachment=true - Should Scoop try to capture and save the SSL/TLS certificates for the different origins encountered during capture?. This capture happens out of the browser.
 * @property {boolean} provenanceSummary=true - If `true`, information about the capture process (public IP address, User Agent, software version ...) will be gathered and summarized under `file:///provenance-summary.html`. WACZ exports will also hold that information at `datapackage.json` level, under `extras`.
 * @property {boolean} attachmentsBypassLimits=true - If `true`, "attachments" will not count towards the time and size constraints imposed on the capture itself (captureTimeout, maxCaptureSize).
 *
 * @property {number} captureTimeout=60000 - Time budget shared by every target in the capture, in ms; not a per-page budget.
 * @property {number} loadTimeout=20000 - How long should Scoop wait for the page to load, in ms?
 * @property {number} networkIdleTimeout=20000 - How long should Scoop wait for network events to complete, in ms.
 * @property {number} behaviorsTimeout=20000 - How long should Scoop wait for media to play, secondary resources, and site specific behaviors (in total), in ms?
 * @property {number} captureVideoAsAttachmentTimeout=30000 - How long should Scoop wait for `captureVideoAsAttachment` to finish.
 * @property {number} captureCertificatesAsAttachmentTimeout=10000 - How long should Scoop wait for `captureCertificatesAsAttachment` to finish.
 *
 * @property {number} captureWindowX=1600 - Browser window resolution in pixels: X axis.
 * @property {number} captureWindowY=900 - Browser window resolution in pixels: Y axis.
 * @property {number} screenshotMaxWidth=0 - Widest full-page screenshot to take, in pixels. A wider page is clipped to this width, from the left. 0 means no limit.
 * @property {number} screenshotMaxHeight=0 - Tallest full-page screenshot to take, in pixels. A taller page is clipped to this height, from the top. 0 means no limit. Chromium's memory use grows with the area it renders: an unbounded screenshot of a very tall page can take gigabytes.
 *
 * @property {number} maxCaptureSize=209715200 - Received-byte budget shared by all targets, in bytes. Generated bodies also count cumulatively in array mode when attachmentsBypassLimits is false.
 *
 * @property {number} maxVideoCaptureSize=209715200 - Maximum size, in bytes, for video attachments. Scoop will not capture video attachments larger than this.
 *
 * @property {boolean} autoScroll=true - Should Scoop try to scroll through the page?
 * @property {boolean} autoPlayMedia=true - Should Scoop try to autoplay `<audio>` and `<video>` tags?
 * @property {boolean} grabSecondaryResources=true - Should Scoop try to download img srcsets and secondary stylesheets?
 * @property {boolean} runSiteSpecificBehaviors=true - Should Scoop run site-specific capture behaviors? (via: browsertrix-behaviors)
 *
 * @property {boolean} headless=true - Should Playwright run in headless mode?
 * @property {boolean} chromiumSandbox=true - Enable Chromium's internal sandbox. Operator setting; requires a compatible host or worker image. Launch failure does not retry without the sandbox.
 * @property {string} userAgentSuffix="" - String to append to the user agent.
 *
 * @property {string[]} blocklist - A list of patterns to be matched against each request's URL and IP address and subsequently blocked during capture. Valid entries include url strings, CIDR strings, and regular expressions in string form.
 * @property {string} intercepter="ScoopProxy" - Network interception method to be used. Available at the moment: "ScoopProxy".
 * @property {string} proxyHost="localhost" - What host should Playwright proxy through for capture?
 * @property {number} proxyPort=9000 - What port should Playwright proxy through for capture?
 * @property {boolean} proxyVerbose=false - Should log entries from the proxy be printed?
 *
 * @property {string} publicIpResolverEndpoint="https://icanhazip.com" - URL to be used to retrieve the client's public IP address for `provenanceSummary`. Endpoint requirements: must simply return a IPv4 or IPv6 address as text.
 * @property {string} ytDlpPath="./executables/yt-dlp" - Path to the yt-dlp executable to be used. (https://github.com/yt-dlp/yt-dlp)
 * @property {string} cripPath="./executables/crip" - Path to the crip executable to be used. (https://github.com/Hakky54/certificate-ripper)
 */

/**
 * A rejected upstream certificate; snapshots are descriptive and never change trust.
 * @typedef {Object} ScoopCaptureError
 * @property {'tls_validation_failed'} kind
 * @property {string} code - Original Node certificate verification code.
 * @property {string} message - Original certificate diagnostic.
 * @property {'head'|'proxy'} phase
 * @property {?string} url - Credential-free destination; null when only CONNECT authority is known.
 * @property {string} hostname
 * @property {number} port - Effective destination port.
 * @property {?string} pageId - Owning array attempt; null for string captures or unowned requests.
 */

/**
 * Descriptive page inventory; new captures use version 2, version 1 remains readable. Public getters return independent copies.
 * Page work ends before global certificate/provenance steps and export/signing.
 * @typedef {Object} ScoopMultipage
 * @property {1|2} version
 * @property {?string} startedAt - UTC capture start; null before setup.
 * @property {?string} finishedAt - UTC end of page work; null while active.
 * @property {string[]} urls - Validated, ordered requested URLs.
 * @property {ScoopPageResult[]} pages
 */

/**
 * One explicitly requested target, including failed and skipped targets.
 * @typedef {Object} ScoopPageResult
 * @property {string} id - Stable page-0001-style identifier.
 * @property {string} requestedUrl
 * @property {?string} resolvedUrl - Last matched recorded response URL.
 * @property {?string} startedAt
 * @property {?string} finishedAt
 * @property {'pending'|'capturing'|'complete'|'partial'|'failed'|'skipped'} outcome
 * @property {?string} reason - Machine-readable cause; null for complete results.
 * @property {?number} httpStatus - Observation, not a success criterion.
 * @property {?string} contentType
 * @property {Object} pageInfo - Page metadata without the favicon buffer.
 * @property {?{url: string, ts: string}} entryPoint - Requested URL and first recorded navigation timestamp.
 * @property {Object<string, string|string[]>} attachments - Safe generated filenames.
 * @property {ScoopMultipageStep[]} steps
 */

/**
 * Array-mode execution trace; ordinary caught errors retain baseline state rules.
 * @typedef {Object} ScoopMultipageStep
 * @property {string} id - Capture-wide step-0001-style identifier.
 * @property {?string} pageId - Null for global certificate/provenance work.
 * @property {string} name
 * @property {string} startedAt - UTC timestamp.
 * @property {number} durationMs
 * @property {'completed'|'failed'|'limit'|'interrupted'|'skipped'} outcome
 * @property {?string} reason
 */
