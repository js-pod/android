// Entry point for nodejs-mobile inside the Android app.
// Boots JSS in-process (no `spawn jss` — Android can't fork a binary)
// and reports status back to the React Native UI via rn-bridge.

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join, posix } from 'path'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
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
const BOOTSTRAP_APPS = ['pilot', 'profile', 'home']

async function seedAppsOnFirstRun(podRoot) {
  const appsDir = join(podRoot, 'public', 'apps')
  if (existsSync(appsDir) && readdirSync(appsDir).length > 0) {
    send({ type: 'status', message: 'apps/ already populated, skipping bootstrap' })
    return
  }
  mkdirSync(appsDir, { recursive: true })
  send({ type: 'status', message: `bootstrap: installing ${BOOTSTRAP_APPS.join(', ')}...` })
  for (const app of BOOTSTRAP_APPS) {
    try {
      await installApp(app, appsDir)
      send({ type: 'status', message: `bootstrap: installed ${app}` })
    } catch (err) {
      send({ type: 'status', message: `bootstrap: ${app} failed — ${err && err.message || err}` })
    }
  }
  send({ type: 'status', message: 'bootstrap done' })
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

async function installApp(name, appsDir) {
  const treeUrl = `https://data.jsdelivr.com/v1/package/gh/solid-apps/${name}@gh-pages/tree`
  const treeRes = await fetch(treeUrl)
  if (!treeRes.ok) throw new Error(`tree ${treeRes.status} for ${name}`)
  const tree = await treeRes.json()
  const files = flattenJsdelivrTree(tree.files || [], '')
  if (!files.length) throw new Error(`empty tree for ${name}`)
  const appDir = join(appsDir, name)
  mkdirSync(appDir, { recursive: true })
  for (const file of files) {
    const url = `https://cdn.jsdelivr.net/gh/solid-apps/${name}@gh-pages/${file}`
    const dest = join(appDir, ...file.split(posix.sep))
    mkdirSync(dirname(dest), { recursive: true })
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${file} ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(dest, buf)
  }
}

try {
  // nodejs-mobile starts with CWD='/' (read-only). Move to the writable
  // extracted project dir so JSS's ./pod-data lands somewhere we can write.
  const projectDir = dirname(fileURLToPath(import.meta.url))
  process.chdir(projectDir)
  send({ type: 'status', message: 'cwd=' + process.cwd() })

  const port = await findFreePort(PORT, HOST)
  if (port === null) throw new Error(`no free port in ${PORT}..${PORT + 9} on ${HOST}`)
  if (port !== PORT) send({ type: 'status', message: `port ${PORT} in use, using ${port}` })

  send({ type: 'status', message: 'loading javascript-solid-server...' })
  const { createServer } = await import('javascript-solid-server/src/server.js')

  send({ type: 'status', message: 'creating server...' })
  const server = createServer({
    root: './pod-data',
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
  seedAppsOnFirstRun(join(process.cwd(), 'pod-data')).catch((err) => {
    send({ type: 'status', message: 'bootstrap failed: ' + String(err && err.stack || err) })
  })
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
