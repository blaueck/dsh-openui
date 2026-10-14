/**
 * Render one OpenUI card frame in real headless Chrome and report what happened.
 *
 * This reproduces exactly what the browser half does — the same `srcdoc`, the
 * same sandbox, the same postMessage handshake — so a frame that fails here
 * fails in the conversation too, and the console errors that the sandbox
 * swallows become visible.
 *
 * Usage: node scripts/verify-frame.mjs [path-to-program.openui]
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFrameDoc, FRAME_TOKEN_FIELD } from '../src/shell.ts'
import { FRAME_CSS } from '../src/frame-css.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 8791
const CDP_PORT = 9333

const DEFAULT_PROGRAM = `root = Stack([h, c], "column", "m")
h = CardHeader("Frame verification")
c = Callout("info", "Rendered by @openuidev/react-ui", "If you can read this, the frame booted, imported the runtime, and rendered a component.")
`

const program = process.argv[2] !== undefined
  ? readFileSync(process.argv[2], 'utf8')
  : DEFAULT_PROGRAM

const token = 'verify-token'
const frameDoc = buildFrameDoc({ token, css: FRAME_CSS })

/** Embed a value in the harness script without letting its `<` close the block. */
const forScript = value => JSON.stringify(value).replaceAll('<', '\\u003c')

/** The harness page: the card's own iframe plus a visible transcript of the frame protocol. */
const harness = `<!doctype html>
<html><head><meta charset="utf-8"><title>pending</title>
<style>body{margin:0;font:13px ui-monospace,monospace;background:#fff;color:#111}
#log{padding:8px;white-space:pre-wrap;border-bottom:1px solid #ccc;max-height:220px;overflow:auto}
iframe{display:block;width:100%;border:0;background:transparent}</style></head>
<body>
<pre id="log"></pre>
<script>
const TOKEN = ${forScript(token)};
const TOKEN_FIELD = ${forScript(FRAME_TOKEN_FIELD)};
const PROGRAM = ${forScript(program)};
const FRAME_DOC = ${forScript(frameDoc)};
const log = document.getElementById('log');
const lines = [];
function say(text) { lines.push(text); log.textContent = lines.join('\\n'); }
window.onerror = (m) => say('PARENT ERROR: ' + m);
window.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || d[TOKEN_FIELD] !== TOKEN) return;
  if (d.type === 'height') { document.getElementById('f').style.height = d.height + 'px'; return; }
  say('frame -> ' + d.type + (d.message ? ': ' + d.message : '') + (d.height ? ' (' + d.height + 'px)' : ''));
  if (d.type === 'ready') {
    document.getElementById('f').contentWindow.postMessage(
      Object.assign({ [TOKEN_FIELD]: TOKEN, type: 'set', source: PROGRAM, streaming: false,
        scheme: 'light', theme: {} }), '*');
    say('parent -> set (' + PROGRAM.length + ' chars)');
  }
});
const f = document.createElement('iframe');
f.id = 'f';
f.setAttribute('sandbox', 'allow-scripts');
f.setAttribute('referrerpolicy', 'no-referrer');
f.srcdoc = FRAME_DOC;
f.style.height = '56px';
f.onload = () => say('iframe load event');
document.body.appendChild(f);
setTimeout(() => { document.title = 'done'; }, 25000);
</script>
</body></html>`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(harness)
})
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))

const profile = mkdtempSync(join(tmpdir(), 'openui-verify-'))
const dumps = mkdtempSync(join(tmpdir(), 'openui-dumps-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  // Chrome's own sandbox and Crashpad both need host paths this environment
  // denies; neither is needed to render a frame under test.
  '--no-sandbox',
  '--disable-gpu',
  '--disable-crashpad',
  '--disable-breakpad',
  '--disable-dev-shm-usage',
  `--crash-dumps-dir=${dumps}`,
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--window-size=900,1000',
  `http://127.0.0.1:${PORT}/`,
], { stdio: ['ignore', 'pipe', 'pipe'] })

let chromeErr = ''
chrome.stderr.on('data', chunk => { chromeErr += chunk.toString() })

/** Poll the CDP HTTP endpoint until the browser is up. */
async function debuggingTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const page = list.find(target => target.type === 'page' && target.url.includes(String(PORT)))
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Chrome DevTools endpoint never came up')
}

const target = await debuggingTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const consoleLines = []
const contexts = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    pending.get(message.id)?.(message)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Runtime.executionContextCreated') {
    contexts.push(message.params.context)
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? []).map(a => a.value ?? a.description ?? a.type).join(' ')
    consoleLines.push(`[${message.params.type}] ${text}`)
  }
  if (message.method === 'Log.entryAdded') {
    consoleLines.push(`[${message.params.entry.level}] ${message.params.entry.text}`)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const d = message.params.exceptionDetails
    const where = `${d.url ?? '?'}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}`
    consoleLines.push(`[exception] ${d.exception?.description ?? d.text} @ ${where}`)
  }
})

const send = (method, params = {}) => new Promise(resolve => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
// Let the frame fetch the runtime from the CDN and render.
await new Promise(resolve => setTimeout(resolve, 22_000))

const dom = await send('Runtime.evaluate', {
  expression: 'document.getElementById("log").textContent',
  returnByValue: true,
})
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync('/tmp/openui-frame-verify.png', Buffer.from(shot.result.data, 'base64'))

console.log('=== frame protocol transcript (as the parent saw it) ===')
console.log(dom.result?.result?.value ?? '(none)')

// Reach into the sandboxed frame's own execution context: the parent cannot read
// its DOM, but DevTools can, and that is where a silent render failure shows up.
const tree = await send('Page.getFrameTree')
const childFrameId = tree.result?.frameTree?.childFrames?.[0]?.frame?.id
const frameContext = contexts.find(c => c.auxData?.frameId === childFrameId && c.auxData?.isDefault)
if (frameContext === undefined) {
  console.log(`\n=== frame DOM ===\n(no execution context for child frame ${childFrameId ?? '?'}; contexts: ${contexts.length})`)
} else {
  const probe = await send('Runtime.evaluate', {
    contextId: frameContext.id,
    expression: `JSON.stringify({
      bodyText: document.body ? document.body.innerText.slice(0, 1200) : null,
      bodyHtmlLength: document.body ? document.body.innerHTML.length : -1,
      mountChildren: document.getElementById('openui-mount')?.childElementCount ?? -1,
      rootClasses: document.querySelector('[class]')?.className ?? null,
      scrollHeight: document.documentElement.scrollHeight,
      noticeText: document.querySelector('.openui-frame-notice')?.textContent ?? null,
    })`,
    returnByValue: true,
  })
  console.log('\n=== frame DOM ===')
  const value = probe.result?.result?.value
  console.log(value === undefined ? JSON.stringify(probe.result, null, 1).slice(0, 800) : value)
}

console.log('\n=== browser console / log ===')
console.log(consoleLines.length === 0 ? '(nothing logged)' : consoleLines.join('\n'))
console.log('\nscreenshot: /tmp/openui-frame-verify.png')
if (chromeErr.trim().length > 0) {
  const relevant = chromeErr.split('\n').filter(l => /error|ERROR|WARN/.test(l)).slice(0, 10)
  if (relevant.length > 0) console.log('\n=== chrome stderr (filtered) ===\n' + relevant.join('\n'))
}

socket.close()
chrome.kill('SIGKILL')
server.close()
process.exit(0)
