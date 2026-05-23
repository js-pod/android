// Entry point for nodejs-mobile inside the Android app.
// nodejs-mobile-react-native extracts this folder to internal storage on first
// run and executes this file in an embedded Node.js runtime. We then start a
// JSS pod (via the jspod CLI's library entry) and post status messages back to
// the React Native UI over the IPC channel.

// rn-bridge is injected by nodejs-mobile as a built-in CommonJS module; ESM's
// loader can't resolve it, so reach for createRequire.
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
const rn_bridge = createRequire(import.meta.url)('rn-bridge')

// nodejs-mobile starts with CWD='/' which is read-only on Android. jspod
// creates ./pod-data relative to CWD, so move to the writable extracted
// project dir before booting.
process.chdir(dirname(fileURLToPath(import.meta.url)))

// Tell jspod not to try to open a browser — there's no `xdg-open` here, and
// the RN UI handles opening the system browser via Intent.
process.env.JSPOD_NO_OPEN = '1'

// Default port. The RN UI reads this and displays it.
const PORT = process.env.JSPOD_PORT || '5444'
process.env.JSPOD_PORT = PORT

rn_bridge.channel.send(JSON.stringify({ type: 'status', message: 'starting pod...' }))

try {
  // Construct argv as if `npx jspod --port 5444 --no-open` was invoked.
  process.argv = [process.argv[0] || 'node', 'jspod', '--port', PORT, '--no-open']

  // Dynamic import so we can catch failure at boot. jspod is ESM.
  await import('jspod')

  rn_bridge.channel.send(JSON.stringify({
    type: 'ready',
    port: PORT,
    url: `http://localhost:${PORT}/`
  }))
} catch (err) {
  rn_bridge.channel.send(JSON.stringify({
    type: 'error',
    message: String(err && err.stack || err)
  }))
}

// Optional: listen for control messages from RN (stop, status check, etc.)
rn_bridge.channel.on('message', (msg) => {
  try {
    const parsed = JSON.parse(msg)
    if (parsed.type === 'ping') {
      rn_bridge.channel.send(JSON.stringify({ type: 'pong', port: PORT }))
    }
  } catch {
    // ignore non-JSON messages
  }
})

// Keep the process alive — jspod's HTTP server holds it, but if it crashed we
// still want this script to stay resident so the RN side gets the error.
setInterval(() => {}, 1 << 30)
