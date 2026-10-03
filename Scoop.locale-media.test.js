import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { Scoop } from './Scoop.js'
import { FIXTURES_PATH } from './constants.js'
import { defaults } from './options.js'

await test('pinned yt-dlp propagates locale to metadata, direct media, HLS segments and all subtitles', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'scoop-locale-media-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const callsPath = join(directory, 'calls.jsonl')
  const downloader = join(directory, 'yt-dlp.mjs')
  // Record arguments, then execute the real pinned downloader unchanged.
  await writeFile(downloader, `#!/usr/bin/env node
    import { appendFileSync } from 'node:fs'
    import { spawnSync } from 'node:child_process'
    const args = process.argv.slice(2)
    appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
    const child = spawnSync(${JSON.stringify(defaults.ytDlpPath)}, args, { stdio: 'inherit' })
    process.exit(child.status ?? 1)
  `, { mode: 0o755 })
  const direct = await readFile(join(FIXTURES_PATH, 'video.mp4'))
  const init = await readFile(join(FIXTURES_PATH, 'locale-hls/init.mp4'))
  const segments = await Promise.all([0, 1].map(index => readFile(join(FIXTURES_PATH, `locale-hls/segment-${index}.m4s`))))
  const requests = []
  const first = express()
  const second = express()
  for (const app of [first, second]) {
    app.use((req, _res, next) => {
      requests.push({ path: req.path, method: req.method, language: req.headers['accept-language'], mode: req.headers['sec-fetch-mode'] })
      next()
    })
  }
  async function listen (app) {
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => { server.closeAllConnections(); server.close() })
    return `http://127.0.0.1:${server.address().port}`
  }
  const firstUrl = await listen(first)
  const secondUrl = await listen(second)
  first.get('/start/:kind/:id', (req, res) => res.redirect(`${secondUrl}/metadata/${req.params.kind}/${req.params.id}`))
  second.get('/metadata/:kind/:id', (req, res) => {
    const { kind, id } = req.params
    const source = kind === 'direct' ? `${firstUrl}/file/${id}/video.mp4` : `${firstUrl}/hls/${id}/master.m3u8`
    res.send(`<!doctype html><title>Locale media fixture</title><link rel="icon" href="data:,">
      <video controls preload="none"><source src="${source}" type="${kind === 'direct' ? 'video/mp4' : 'application/x-mpegURL'}">
      <track kind="subtitles" src="${firstUrl}/subs/${id}/en.vtt" srclang="en" label="English">
      <track kind="subtitles" src="${firstUrl}/subs/${id}/es.vtt" srclang="es" label="Spanish"></video>`)
  })
  first.get('/file/:id/video.mp4', (req, res) => res.redirect(`${secondUrl}/media/${req.params.id}/video.mp4`))
  second.get('/media/:id/video.mp4', (_req, res) => res.type('video/mp4').send(direct))
  first.get('/subs/:id/:language.vtt', (req, res) => res.redirect(`${secondUrl}/subtitle/${req.params.id}/${req.params.language}.vtt`))
  second.get('/subtitle/:id/:language.vtt', (_req, res) => res.type('text/vtt').send('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nLocal subtitle\n'))
  first.get('/hls/:id/master.m3u8', (req, res) => res.type('application/vnd.apple.mpegurl').send(
    `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10000,CODECS="avc1.42c00a",RESOLUTION=32x32\n${secondUrl}/hls/${req.params.id}/index.m3u8\n`
  ))
  second.get('/hls/:id/index.m3u8', (req, res) => res.type('application/vnd.apple.mpegurl').send(
    `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="${firstUrl}/hls/${req.params.id}/init.mp4"\n#EXTINF:1.0,\n${firstUrl}/hls/${req.params.id}/segment-0.m4s\n#EXTINF:1.0,\n${secondUrl}/hls/${req.params.id}/segment-1.m4s\n#EXT-X-ENDLIST\n`
  ))
  first.get('/hls/:id/init.mp4', (_req, res) => res.type('video/mp4').send(init))
  first.get('/hls/:id/segment-0.m4s', (_req, res) => res.type('video/mp4').send(segments[0]))
  second.get('/hls/:id/segment-1.m4s', (_req, res) => res.type('video/mp4').send(segments[1]))

  const baselineHeaders = new Map()
  for (const kind of ['direct', 'hls']) {
    for (const [id, locale] of [['baseline', undefined], ['empty', ''], ['spanish', 'es-es']]) {
      const start = requests.length
      const capture = await Scoop.capture(`${firstUrl}/start/${kind}/${id}`, {
        locale,
        logLevel: 'silent',
        blocklist: [],
        proxyHost: '127.0.0.1',
        proxyPort: 0,
        screenshot: false,
        captureVideoAsAttachment: true,
        ytDlpPath: downloader,
        captureCertificatesAsAttachment: false,
        provenanceSummary: false,
        autoScroll: false,
        autoPlayMedia: false,
        grabSecondaryResources: false,
        runSiteSpecificBehaviors: false,
        networkIdleTimeout: 1000
      })
      const step = capture.steps.find(step => step.name.includes('video as attachment'))
      assert.equal(step.outcome, 'completed', JSON.stringify(step))
      assert.equal(capture.state, Scoop.states.COMPLETE)
      const video = capture.exchanges.find(exchange => exchange.url === 'file:///video-extracted-1.mp4')
      assert(video?.response.body.length > 0, 'downloaded video must be attached')
      if (kind === 'direct') assert.deepEqual(video.response.body, direct)
      for (const language of ['en', 'es']) {
        assert(capture.exchanges.some(exchange => exchange.url === `file:///video-extracted-1.${language}.vtt`), `${language} subtitle missing`)
      }
      const metadata = JSON.parse(capture.exchanges.find(exchange => exchange.url === 'file:///video-extracted-metadata.json').response.body)
      // This HLS fixture uses the native downloader; no external network downloader is delegated.
      assert.equal(metadata[0].protocol, kind === 'hls' ? 'm3u8_native' : 'http')
      // Both the browser and yt-dlp send Sec-Fetch-Mode. Include all GETs and
      // require a second metadata visit to prove the extractor fetched it too.
      const toolRequests = requests.slice(start).filter(request => request.method === 'GET')
      assert(toolRequests.filter(request => request.path === `/metadata/${kind}/${id}`).length >= 2)
      const required = [
        `/start/${kind}/${id}`, `/metadata/${kind}/${id}`,
        `/subs/${id}/en.vtt`, `/subtitle/${id}/en.vtt`, `/subs/${id}/es.vtt`, `/subtitle/${id}/es.vtt`,
        ...(kind === 'direct'
          ? [`/file/${id}/video.mp4`, `/media/${id}/video.mp4`]
          : [`/hls/${id}/master.m3u8`, `/hls/${id}/index.m3u8`, `/hls/${id}/init.mp4`, `/hls/${id}/segment-0.m4s`, `/hls/${id}/segment-1.m4s`])
      ]
      for (const path of required) assert(toolRequests.some(request => request.path === path), `yt-dlp did not request ${path}`)
      const languages = [...new Set(toolRequests.map(request => request.language))]
      if (locale) assert.deepEqual(languages, ['es-ES'], JSON.stringify(toolRequests))
      else if (id === 'baseline') baselineHeaders.set(kind, languages)
      else assert.deepEqual(languages, baselineHeaders.get(kind))
    }
  }
  const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.length, 12)
  for (let index = 0; index < calls.length; index += 2) {
    assert.deepEqual(calls[index], ['--ignore-config', '--version'])
    const args = calls[index + 1]
    assert.equal(args[args.indexOf('--sub-langs') + 1], 'all')
    const header = args.indexOf('--add-headers')
    if (args.at(-1).endsWith('/spanish')) {
      assert(header > -1 && header < args.indexOf('--'))
      assert.equal(args[header + 1], 'Accept-Language:es-ES')
    } else assert.equal(header, -1)
  }
})
