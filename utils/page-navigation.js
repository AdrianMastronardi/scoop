const networkUrl = input => { const url = new URL(input); url.hash = ''; return url.href }

/** Observe only the initial main-frame navigation and its server redirects. */
export function observeNavigation (page, run, stopped) {
  run.navigation = { first: null, responses: new Map(), finished: new Set() }
  const onRequest = request => {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return
    run.navigation.first ||= request
  }
  const onResponse = response => {
    const request = response.request()
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return
    run.navigation.responses.set(request, response)
    response.finished().then(error => {
      if (!error && !stopped() && run.active) run.navigation.finished.add(request)
    }).catch(() => {})
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  return () => { page.off('request', onRequest); page.off('response', onResponse) }
}

/** Associate retained records without assigning origin-visible correlation data. */
export function associateTarget (run, exchanges) {
  const window = exchanges.slice(run.exchangeStart, run.exchangeEnd)
  let matches = []
  let complete = false
  if (!run.targetUrlIsWebPage) {
    matches = window.filter(ex => ex.request?.startLine.startsWith('GET ') && ex.response)
    complete = run.helperFinished && matches.length > 0 && networkUrl(matches[0].url) === networkUrl(run.url)
  } else if (run.navigation?.first) {
    let request = run.navigation.first
    let position = 0
    complete = true
    while (request) {
      const response = run.navigation.responses.get(request)
      const status = response?.status()
      const index = window.findIndex((ex, i) => i >= position && ex.request?.startLine.split(' ')[0] === request.method() && networkUrl(ex.url) === networkUrl(request.url()) && Number(ex.response?.startLine.split(' ')[1]) === status)
      if (index < 0) complete = false
      else { matches.push(window[index]); position = index + 1 }
      const next = request.redirectedTo()
      if (!next && !run.navigation.finished.has(request)) complete = false
      request = next
    }
  }
  const last = matches.at(-1)
  const status = last ? Number(last.response.startLine.split(' ')[1]) : null
  return {
    resolvedUrl: last?.url || null,
    httpStatus: status,
    contentType: last?.response.headers.get('content-type') || null,
    entryPoint: complete && last && status !== 204 ? { url: run.url, ts: matches[0].date.toISOString() } : null,
    chain: complete && last && status !== 204 ? matches.map(ex => ex.id) : []
  }
}
