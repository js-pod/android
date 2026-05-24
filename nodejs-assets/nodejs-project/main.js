// Entry point for nodejs-mobile inside the Android app.
// Boots JSS in-process (no `spawn jss` — Android can't fork a binary)
// and reports status back to the React Native UI via rn-bridge.

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join, posix } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
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

function send(obj) {
  try { rn_bridge.channel.send(JSON.stringify(obj)) } catch {}
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
const BOOTSTRAP_APPS = ['pilot', 'profile', 'home', 'hub', 'chrome', 'explorer', 'contacts', 'settings']

async function seedAppsOnFirstRun(podRoot) {
  const appsDir = join(podRoot, 'public', 'apps')
  mkdirSync(appsDir, { recursive: true })
  // Per-app + idempotent: (re)install any curated app whose index.html is
  // missing. An app left empty/partial by a transient CDN failure last time
  // self-heals on the next launch instead of being skipped forever (which is
  // what broke chrome — one 502 on a src/ file aborted its whole install).
  for (const app of BOOTSTRAP_APPS) {
    if (existsSync(join(appsDir, app, 'index.html'))) continue
    try {
      console.log('[bootstrap] installing ' + app)
      await installApp(app, appsDir)
      console.log('[bootstrap] installed ' + app)
      send({ type: 'status', message: `bootstrap: installed ${app}` })
    } catch (err) {
      console.error('[bootstrap] ' + app + ' FAILED: ' + (err && err.stack || err))
      send({ type: 'status', message: `bootstrap: ${app} failed — ${err && err.message || err}` })
    }
  }
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
  try {
    return await fetchRetry(`https://cdn.jsdelivr.net/gh/solid-apps/${name}@gh-pages/${file}`, 3)
  } catch (e) {
    return await fetchRetry(`https://raw.githubusercontent.com/solid-apps/${name}/gh-pages/${file}`, 3)
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
    }
  } catch {
    // ignore non-JSON
  }
})

// Keep the script resident even if startup failed, so the UI sees the
// last error and rn-bridge stays connected.
setInterval(() => {}, 1 << 30)
