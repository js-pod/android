// Entry point for nodejs-mobile inside the Android app.
// Boots JSS in-process (no `spawn jss` — Android can't fork a binary)
// and reports status back to the React Native UI via rn-bridge.

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
const rn_bridge = createRequire(import.meta.url)('rn-bridge')

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

try {
  // nodejs-mobile starts with CWD='/' (read-only). Move to the writable
  // extracted project dir so JSS's ./pod-data lands somewhere we can write.
  const projectDir = dirname(fileURLToPath(import.meta.url))
  process.chdir(projectDir)
  send({ type: 'status', message: 'cwd=' + process.cwd() })

  send({ type: 'status', message: 'loading javascript-solid-server...' })
  const { createServer } = await import('javascript-solid-server/src/server.js')

  send({ type: 'status', message: 'creating server...' })
  const server = createServer({
    root: './pod-data',
    conneg: true,
    notifications: true,
    idp: true,
    singleUser: true,
    singleUserPassword: 'me',
    git: false,                      // git http backend off for first run
  })

  send({ type: 'status', message: 'listening on ' + HOST + ':' + PORT + '...' })
  await server.listen({ port: PORT, host: HOST })

  send({
    type: 'ready',
    port: PORT,
    url: `http://${HOST}:${PORT}/`,
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
