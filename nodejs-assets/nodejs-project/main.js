// Entry point for nodejs-mobile inside the Android app.
// Boots JSS in-process (no `spawn jss` — Android can't fork a binary)
// and reports status back to the React Native UI via rn-bridge.

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join, posix } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { webcrypto } from 'crypto'
import { createServer as createNetServer } from 'net'
const rn_bridge = createRequire(import.meta.url)('rn-bridge')

// nodejs-mobile doesn't expose globalThis.crypto (Web Crypto API).
// jose uses it for key generation. Wire it up from node:crypto.
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto
}

// NOTE: crypto.hash() (Node 21.7+) is also missing, but oidc-provider
// imports it via `import * as crypto` (an immutable namespace), so a
// runtime polyfill here can't reach it. It's rewritten at the call
// sites by scripts/patch-android-assets.js instead.

// URL.parse() is a static method added in Node 22.1. Older Node (which
// nodejs-mobile bundles) throws "is not a function". oidc-provider uses
// it as a non-throwing parser. Polyfill with a try/new URL fallback.
if (typeof URL.parse !== 'function') {
  URL.parse = function (input, base) {
    try {
      return base != null ? new URL(input, base) : new URL(input)
    } catch {
      return null
    }
  }
}

// ES2023 change-array-by-copy methods. nodejs-mobile's Node 18 lacks
// them; JSS's IdP uses Array#toReversed (idp/index.js), so OIDC client
// registration 500s without these. Polyfill the family.
function definePoly(proto, name, fn) {
  if (typeof proto[name] !== 'function') {
    Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true })
  }
}
definePoly(Array.prototype, 'toReversed', function () {
  return Array.prototype.slice.call(this).reverse()
})
definePoly(Array.prototype, 'toSorted', function (cmp) {
  return Array.prototype.slice.call(this).sort(cmp)
})
definePoly(Array.prototype, 'with', function (i, value) {
  const copy = Array.prototype.slice.call(this)
  copy[i < 0 ? copy.length + i : i] = value
  return copy
})

// nodejs-mobile is built without ICU, so Intl is undefined. oidc-provider
// (and other deps) reference Intl.ListFormat at module load time, which
// crashes the whole bundle. Stub the surface area we actually need.
if (typeof globalThis.Intl === 'undefined') {
  globalThis.Intl = {
    ListFormat: class {
      constructor(_locale, opts) { this.type = (opts && opts.type) || 'conjunction' }
      format(iter) {
        const arr = Array.from(iter)
        if (arr.length === 0) return ''
        if (arr.length === 1) return String(arr[0])
        if (arr.length === 2) {
          const conj = this.type === 'disjunction' ? 'or' : 'and'
          return arr[0] + ' ' + conj + ' ' + arr[1]
        }
        const conj = this.type === 'disjunction' ? 'or' : 'and'
        return arr.slice(0, -1).join(', ') + ', ' + conj + ' ' + arr[arr.length - 1]
      }
    },
  }
}

const PORT = parseInt(process.env.JSPOD_PORT || '5444', 10)
const HOST = process.env.JSPOD_HOST || 'localhost'
// Same data root the in-process server uses (see the boot IIFE). Module-level
// so the rn-bridge message handler can write into the pod without auth.
const POD_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'pod-data')

function send(obj) {
  try { rn_bridge.channel.send(JSON.stringify(obj)) } catch {}
}

// Write contacts read from the device address book (sent over the bridge by the
// RN UI) straight to disk as vCard JSON-LD under public/contacts/. We are the
// server process, so this needs no OIDC token; reads of /public are public, so
// the contacts app lists them immediately. A stable android-<id> filename makes
// re-import idempotent (updates rather than duplicates).
function importContacts(contacts) {
  const dir = join(POD_ROOT, 'public', 'contacts')
  mkdirSync(dir, { recursive: true })
  let n = 0
  const list = Array.isArray(contacts) ? contacts : []
  list.forEach((c, i) => {
    const emails = (c.emails || []).filter(Boolean)
    const tels = (c.tels || []).filter(Boolean)
    const fn = (c.name || emails[0] || tels[0] || 'Unnamed').toString()
    const id = ((c.id != null ? 'android-' + c.id : 'c-' + i).toString()
      .replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60)) || ('c-' + i)
    const doc = {
      '@context': { vcard: 'http://www.w3.org/2006/vcard/ns#' },
      '@type': 'vcard:Individual',
      'vcard:fn': fn,
      'vcard:hasEmail': emails,
      'vcard:hasTelephone': tels
    }
    try { writeFileSync(join(dir, id + '.jsonld'), JSON.stringify(doc, null, 2)); n++ } catch {}
  })
  return n
}

process.on('uncaughtException', (err) => {
  send({ type: 'error', message: 'uncaught: ' + String(err && err.stack || err) })
})
process.on('unhandledRejection', (reason) => {
  send({ type: 'error', message: 'unhandled rejection: ' + String(reason && reason.stack || reason) })
})

async function findFreePort(start, host, max = 10) {
  for (let p = start; p < start + max; p++) {
    const free = await new Promise((resolve) => {
      const srv = createNetServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(p, host)
    })
    if (free) return p
  }
  return null
}

// First-run app bootstrap. JSS by itself doesn't ship any Solid apps,
// so the pod has nothing the user can sign in *from*. Drop a minimal
// set of solid-apps/* repos straight onto disk under public/apps/ —
// JSS picks them up on next request. Fetched from jsDelivr (gh-pages)
// so the install survives offline once seeded.
const BOOTSTRAP_APPS = ['pilot', 'profile', 'home', 'hub', 'chrome', 'explorer', 'contacts', 'playlist', 'inbox', 'messages', 'store', 'settings']
// Bump to force a one-time re-pull of all bootstrap apps on the next launch
// after an APK update — our reliable channel for shipping app code updates
// (only /public/apps/<app>/ code is overwritten; user data is untouched).
const BOOTSTRAP_GENERATION = 5

// A small curated playlist so the playlist app has a pod-hosted m3u to open
// and edit out of the box. Open it at:
//   /public/apps/playlist/?uri=../../playlists/starter.m3u
const STARTER_M3U = `#EXTM3U
#PLAYLIST:Starter
#EXTINF:-1,Kings Of Leon - Closer
https://www.youtube.com/watch?v=K-5mcoaPc_U
#EXTINF:-1,Dua Lipa - New Rules (Official Music Video)
https://www.youtube.com/watch?v=k2qgadSvNyU
#EXTINF:-1,Lana Del Rey - High By The Beach
https://www.youtube.com/watch?v=QnxpHIl5Ynw
#EXTINF:-1,Caravan Palace - Lone Digger (Official MV)
https://www.youtube.com/watch?v=UbQgXeY_zi4
#EXTINF:-1,RÜFÜS DU SOL - On My Knees (Official Music Video)
https://www.youtube.com/watch?v=y7fudcFIlZs
#EXTINF:-1,Tiësto - Lay Low (Official Music Video)
https://www.youtube.com/watch?v=EfWmWlW2PvM
`

// Seed the starter playlist on first run. Idempotent: skip if it already
// exists so the owner's later edits (saved back via the app) aren't clobbered.
function seedPlaylistOnFirstRun(podRoot) {
  const file = join(podRoot, 'public', 'playlists', 'starter.m3u')
  if (existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, STARTER_M3U)
}

// Drop a welcome note into the (already JSS-seeded, owner-only) inbox so the
// inbox app shows something on first open and the read path is verifiable.
// ActivityStreams as:Note — the same shape ActivityPub uses. Idempotent.
function seedInboxWelcomeOnFirstRun(podRoot) {
  const file = join(podRoot, 'inbox', 'welcome.jsonld')
  if (existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  const note = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'Note',
    summary: 'Welcome to your inbox',
    content: 'This is your Solid pod inbox. Notifications delivered here (Linked Data Notifications, in ActivityStreams) are private — only you can read them. Composing and replying arrive in a later version.',
    published: new Date().toISOString()
  }
  writeFileSync(file, JSON.stringify(note, null, 2))
}

async function seedAppsOnFirstRun(podRoot) {
  const appsDir = join(podRoot, 'public', 'apps')
  mkdirSync(appsDir, { recursive: true })
  // Generation gate: when BOOTSTRAP_GENERATION is ahead of what's recorded on
  // the pod, re-pull every app (ship updates). Otherwise per-app + idempotent:
  // (re)install any app whose index.html is missing, so an app left empty by a
  // transient failure self-heals next launch instead of being skipped forever.
  const genFile = join(podRoot, '.bootstrap-generation')
  let storedGen = 0
  try { storedGen = parseInt(readFileSync(genFile, 'utf8'), 10) || 0 } catch { /* none yet */ }
  const refresh = storedGen < BOOTSTRAP_GENERATION
  for (const app of BOOTSTRAP_APPS) {
    if (!refresh && existsSync(join(appsDir, app, 'index.html'))) continue
    try {
      console.log('[bootstrap] installing ' + app + (refresh ? ' (refresh)' : ''))
      await installApp(app, appsDir)
      console.log('[bootstrap] installed ' + app)
      send({ type: 'status', message: `bootstrap: installed ${app}` })
    } catch (err) {
      console.error('[bootstrap] ' + app + ' FAILED: ' + (err && err.stack || err))
      send({ type: 'status', message: `bootstrap: ${app} failed — ${err && err.message || err}` })
    }
  }
  try { writeFileSync(genFile, String(BOOTSTRAP_GENERATION)) } catch { /* best effort */ }
}

// fetch with retries + backoff — jsDelivr/CDN occasionally returns transient
// 5xx or times out on individual files; one such blip used to abort an app's
// whole install. Retry before giving up.
async function fetchRetry(url, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
      last = new Error(`HTTP ${res.status}`)
    } catch (e) { last = e }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)))
  }
  throw last || new Error('fetch failed: ' + url)
}

function flattenJsdelivrTree(nodes, prefix) {
  const out = []
  for (const node of nodes) {
    const p = prefix ? prefix + '/' + node.name : node.name
    if (node.type === 'file') out.push(p)
    else if (node.type === 'directory') out.push(...flattenJsdelivrTree(node.files || [], p))
  }
  return out
}

// List an app's files. Primary: jsDelivr's tree API. Fallback: GitHub's
// git-trees API — jsDelivr's tree endpoint 500s for some repos (e.g. hub,
// with its nested src/ + directory/ layout) even though individual file
// fetches via the CDN still work.
async function listAppFiles(name) {
  try {
    const r = await fetch(`https://data.jsdelivr.com/v1/package/gh/solid-apps/${name}@gh-pages/tree`)
    if (r.ok) {
      const files = flattenJsdelivrTree((await r.json()).files || [], '')
      if (files.length) return files
    }
  } catch { /* fall through to GitHub */ }
  const r = await fetchRetry(`https://api.github.com/repos/solid-apps/${name}/git/trees/gh-pages?recursive=1`)
  const files = ((await r.json()).tree || []).filter((t) => t.type === 'blob').map((t) => t.path)
  if (!files.length) throw new Error(`empty file list for ${name}`)
  return files
}

// Fetch one app file. Try jsDelivr (fast, cached); fall back to raw
// .githubusercontent.com, which serves immediately for any pushed commit —
// no per-edge CDN warm-up or indexing lag (brand-new repos like settings).
async function fetchAppFile(name, file) {
  // raw.githubusercontent first: it always serves the current commit of the
  // branch — no CDN branch-ref cache, no purge needed. jsDelivr is only a
  // fallback (it serves stale @gh-pages files with a 200, which silently
  // defeats freshness — so it must not be the primary source for updates).
  try {
    return await fetchRetry(`https://raw.githubusercontent.com/solid-apps/${name}/gh-pages/${file}`, 3)
  } catch (e) {
    return await fetchRetry(`https://cdn.jsdelivr.net/gh/solid-apps/${name}@gh-pages/${file}`, 3)
  }
}

async function installApp(name, appsDir) {
  const files = await listAppFiles(name)
  const appDir = join(appsDir, name)
  mkdirSync(appDir, { recursive: true })
  for (const file of files) {
    const dest = join(appDir, ...file.split(posix.sep))
    mkdirSync(dirname(dest), { recursive: true })
    const res = await fetchAppFile(name, file)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(dest, buf)
  }
}

// INTERIM (remove once this app boots via jspod.start({ inProcess: true }) —
// JavaScriptSolidServer/jspod#58 / PR #59): copy jspod's onboarding pages into
// the pod root, mirroring jspod's seedPodFiles(), so the home + sign-in screens
// match jspod instead of JSS's bare defaults. Fetched from jsDelivr (npm). This
// duplicates jspod's seeding on purpose; delete it when jspod does it for us.
const JSPOD_PAGES_VERSION = '0.0.42'
const JSPOD_PAGES = [
  // [file in jspod package, dest under pod root, overwrite-if-exists]
  ['welcome.html', 'index.html', true],
  ['signin.html', 'signin.html', true],
  ['signin.html.acl', 'signin.html.acl', true],
  ['account.html', 'account.html', true],
  ['account.html.acl', 'account.html.acl', true],
  ['docs.html', 'docs.html', true],
  ['docs.html.acl', 'docs.html.acl', true],
  ['links.jsonld', 'public/links.jsonld', false]
]

async function seedPodPagesOnFirstRun(podRoot) {
  const marker = join(podRoot, '.jspod-pages-seeded')
  if (existsSync(marker)) return
  send({ type: 'status', message: 'bootstrap: seeding jspod onboarding pages...' })
  let any = false
  for (const [remote, destRel, overwrite] of JSPOD_PAGES) {
    try {
      const dest = join(podRoot, ...destRel.split('/'))
      if (!overwrite && existsSync(dest)) continue
      const res = await fetch(`https://cdn.jsdelivr.net/npm/jspod@${JSPOD_PAGES_VERSION}/${remote}`)
      if (!res.ok) continue
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
      any = true
    } catch { /* best-effort; offline first-run keeps JSS's bare pages */ }
  }
  if (any) {
    try { writeFileSync(marker, new Date().toISOString()) } catch {}
    send({ type: 'status', message: 'bootstrap: jspod onboarding pages seeded' })
  }
}

try {
  // nodejs-mobile starts with CWD='/' (read-only); chdir into the writable
  // extracted project dir for any relative path use.
  const projectDir = dirname(fileURLToPath(import.meta.url))
  process.chdir(projectDir)

  // Pod data must live OUTSIDE the extracted project dir: nodejs-mobile
  // re-extracts nodejs-project/ on app update, which would wipe a pod-data
  // nested inside it. A sibling under the app's files dir
  // (files/pod-data) is managed by us, not nodejs-mobile, so it survives
  // updates. Absolute path so it's independent of cwd.
  const dataDir = join(projectDir, '..', 'pod-data')
  mkdirSync(dataDir, { recursive: true })
  send({ type: 'status', message: 'data=' + dataDir })

  const port = await findFreePort(PORT, HOST)
  if (port === null) throw new Error(`no free port in ${PORT}..${PORT + 9} on ${HOST}`)
  if (port !== PORT) send({ type: 'status', message: `port ${PORT} in use, using ${port}` })

  send({ type: 'status', message: 'loading javascript-solid-server...' })
  const { createServer } = await import('javascript-solid-server/src/server.js')

  send({ type: 'status', message: 'creating server...' })
  const server = createServer({
    root: dataDir,
    conneg: true,
    notifications: true,
    idp: true,
    // Trailing slash is load-bearing: JSS forces a trailing slash on the
    // discovery-doc issuer ("CTH compatibility") but emits the RFC 9207
    // `iss` param as the raw issuer. A strict client (solid-oidc) compares
    // them byte-for-byte, so they must match — pass the slash form here.
    idpIssuer: `http://${HOST}:${port}/`,
    singleUser: true,
    singleUserPassword: 'me',
    git: false,
  })

  send({ type: 'status', message: `listening on ${HOST}:${port}...` })
  await server.listen({ port, host: HOST })

  send({
    type: 'ready',
    port,
    url: `http://${HOST}:${port}/`,
  })

  // Best-effort first-run app install — runs after the pod is already
  // serving so the UI flips to "ready" right away. Any error here gets
  // surfaced as a status message but doesn't take down the pod.
  ;(async () => {
    try { await seedPodPagesOnFirstRun(dataDir) } catch {}
    try { seedPlaylistOnFirstRun(dataDir) } catch {}
    try { seedInboxWelcomeOnFirstRun(dataDir) } catch {}
    try {
      await seedAppsOnFirstRun(dataDir)
    } catch (err) {
      send({ type: 'status', message: 'bootstrap failed: ' + String(err && err.stack || err) })
    }
  })()
} catch (err) {
  send({ type: 'error', message: String(err && err.stack || err) })
}

rn_bridge.channel.on('message', (msg) => {
  try {
    const parsed = JSON.parse(msg)
    if (parsed.type === 'ping') {
      send({ type: 'pong', port: PORT })
    } else if (parsed.type === 'import-contacts') {
      const count = importContacts(parsed.contacts)
      console.log('[import] wrote ' + count + ' contacts')
      send({ type: 'import-result', count })
    }
  } catch {
    // ignore non-JSON
  }
})

// Keep the script resident even if startup failed, so the UI sees the
// last error and rn-bridge stays connected.
setInterval(() => {}, 1 << 30)
