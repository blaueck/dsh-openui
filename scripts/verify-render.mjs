/**
 * Run the real `buildFrameDoc` output as the top-level document and read what it
 * actually painted.
 *
 * The iframe plumbing is covered by `verify-frame.mjs` (boot → ready → set →
 * error all flow). What that test cannot see is the sandboxed frame's DOM, and
 * with the frame as the top-level document `parent === window`, so the protocol
 * loops back on itself and DevTools can read everything directly.
 *
 * Usage: node scripts/verify-render.mjs [path-to-program.openui]
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFrameDoc, FRAME_TOKEN_FIELD } from '../src/shell.ts'
import { FRAME_CSS } from '../src/frame-css.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 8792
const CDP_PORT = 9334

const program = process.argv[2] !== undefined
  ? readFileSync(process.argv[2], 'utf8')
  : `root = Card([h, c])\nh = CardHeader("Frame verification")\nc = Callout("info", "OpenUI is rendering", "This is a Callout.")\n`

const token = 'inspect-token'
const frameDoc = buildFrameDoc({ token, css: FRAME_CSS })

// Injected into the real frame document, just before its closing body tag.
const probe = `<script>
(function () {
  var PROGRAM = ${JSON.stringify(program).replaceAll('<', '\\u003c')};
  var TOKEN_FIELD = ${JSON.stringify(FRAME_TOKEN_FIELD)};
  var out = [];
  function rec(k, v) { out.push(k + '=' + v); document.title = out.join(' | '); }
  // Stand-in host tools. The frame's tool calls are answered here exactly as the
  // browser half answers them, so a Query() round trip is exercised without a
  // host: request out with a correlation id, matching reply back.
  var TOOLS = {
    demo_files: { root: '/demo', paths: ['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts'] },
  };
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d[TOKEN_FIELD]) return;
    if (d.type === 'height') return;
    if (d.type === 'toolcall') {
      rec('toolcall', d.tool + ':' + d.kind);
      var value = TOOLS[d.tool];
      var reply = { type: 'toolresult', id: d.id, ok: value !== undefined };
      if (value !== undefined) reply.value = value;
      else reply.error = 'not in the allowlist';
      reply[TOKEN_FIELD] = d[TOKEN_FIELD];
      window.postMessage(reply, '*');
      return;
    }
    rec(d.type, d.message || 'ok');
    if (d.type === 'ready') {
      // Exactly what the browser half sends for a settled card: the host's own
      // read/write split travels with the program, so the frame never has to
      // guess which allowlist a call belongs to.
      var msg = {
        type: 'set',
        source: PROGRAM,
        streaming: false,
        scheme: 'light',
        theme: {},
        readTools: ['demo_files'],
        writeTools: [],
      };
      msg[TOKEN_FIELD] = d[TOKEN_FIELD];
      window.postMessage(msg, '*');
    }
  });
  setTimeout(function () {
    var mount = document.getElementById('openui-mount');
    rec('mountChildren', mount ? mount.childElementCount : 'no-mount');
    var text = (document.body.innerText || '').replace(/\\s+/g, ' ');
    rec('text', text.slice(0, 500));
    // The decisive check for a Query: the fetched rows must be on screen, which
    // they only are if the round trip resolved and the renderer re-evaluated.
    rec('fetched', text.indexOf('src/alpha.ts') !== -1 || text.indexOf('src/beta.ts') !== -1 ? 'yes' : 'no');
    var notice = document.querySelector('.openui-frame-notice');
    rec('notice', notice ? notice.textContent.slice(0, 300) : 'none');
    rec('done', 'yes');
  }, 6000);
})();
</script>`

// OPENUI_HTML serves a hand-written page through this same proven harness, so a
// layout question about the React chrome around the frame can be measured with
// the same Chrome flags and CDP plumbing rather than a second browser launch.
// OPENUI_EXTRA_CSS appends candidate overrides to the frame, so a layout fix can
// be proven against the real library CSS before it is committed to frame-css.ts.
const extraCss = process.env.OPENUI_EXTRA_CSS
  ? `<style>${process.env.OPENUI_EXTRA_CSS}</style>`
  : ''
const page = process.env.OPENUI_HTML
  ? readFileSync(process.env.OPENUI_HTML, 'utf8')
  : frameDoc.replace('</body>', `${extraCss}${probe}\n</body>`)

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})
await new Promise(r => server.listen(PORT, '127.0.0.1', r))

const profile = mkdtempSync(join(tmpdir(), 'openui-inspect-'))
const dumps = mkdtempSync(join(tmpdir(), 'openui-dumps-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crashpad', '--disable-breakpad',
  '--disable-dev-shm-usage', `--crash-dumps-dir=${dumps}`,
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--window-size=900,1100', `http://127.0.0.1:${PORT}/`,
], { stdio: ['ignore', 'pipe', 'pipe'] })

async function target() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const found = list.find(t => t.type === 'page' && t.url.includes(String(PORT)))
      if (found?.webSocketDebuggerUrl) return found
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('DevTools endpoint never came up')
}

const t = await target()
const socket = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  socket.addEventListener('open', res, { once: true })
  socket.addEventListener('error', rej, { once: true })
})

let id = 1
const pending = new Map()
const logs = []
socket.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined) { pending.get(m.id)?.(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push('[' + m.params.type + '] ' + (m.params.args ?? []).map(a => a.value ?? a.description ?? a.type).join(' '))
  }
  if (m.method === 'Log.entryAdded') logs.push('[' + m.params.entry.level + '] ' + m.params.entry.text)
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    logs.push('[exception] ' + (d.exception?.description ?? d.text))
  }
})
const send = (method, params = {}) => new Promise(r => { const n = id++; pending.set(n, r); socket.send(JSON.stringify({ id: n, method, params })) })

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
// Measure at a realistic conversation-column width rather than the 900px window:
// a card that fits at 900 can still overflow the column it actually lives in.
const VIEWPORT = Number(process.env.OPENUI_VIEWPORT_WIDTH ?? 900)
await send('Emulation.setDeviceMetricsOverride', {
  width: VIEWPORT, height: 1100, deviceScaleFactor: 1, mobile: false,
})
await new Promise(r => setTimeout(r, 18_000))

const title = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
const detail = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    bodyText: (document.body.innerText || '').slice(0, 900),
    mountHtml: (document.getElementById('openui-mount') || {}).innerHTML?.slice(0, 900) ?? null,
    scrollHeight: document.documentElement.scrollHeight,
  })`,
  returnByValue: true,
})
// Which element is actually wider than the column, and is it a scroller (the
// library's own table wrapper, which should scroll internally) or a box that
// simply will not fit (which pushes the whole card wide)?
const overflow = await send('Runtime.evaluate', {
  expression: `(() => {
    const doc = document.documentElement
    const out = { viewport: doc.clientWidth, docScrollWidth: doc.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth, offenders: [] }
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const isScroller = el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible'
      if (r.right > doc.clientWidth + 1 || isScroller) {
        out.offenders.push({ tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 48), w: Math.round(r.width),
          right: Math.round(r.right), sw: el.scrollWidth, cw: el.clientWidth, ox: cs.overflowX })
      }
    }
    out.offenders = out.offenders.slice(0, 12)
    // Every grid container, with the column template it actually resolved to.
    // A fixed repeat(N, ...) cannot shrink below its tracks, which is how a
    // library default sized for a wide canvas overflows a conversation column.
    out.grids = []
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.display !== 'grid' && cs.display !== 'inline-grid') continue
      out.grids.push({ cls: String(el.className || '').slice(0, 52),
        cols: cs.gridTemplateColumns.slice(0, 90), w: Math.round(el.getBoundingClientRect().width),
        cw: el.clientWidth, sw: el.scrollWidth })
    }
    out.grids = out.grids.slice(0, 10).map(g => ({ ...g,
      cls: String(g.cls).slice(0, 80) }))
    // Walk up from a wide element: the first ancestor that is itself wider than
    // its own parent is the one introducing the overflow.
    // Start from a deep offender, not <html>: the widest *classed* element whose
    // right edge already exceeds the viewport.
    const lim = doc.clientWidth + 1
    const candidates = [...document.querySelectorAll('*')]
      .filter(el => el.className && el.getBoundingClientRect().right > lim)
    const widest = { el: candidates.sort(
      (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] }
    out.chain = []
    for (let el = widest?.el; el && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      out.chain.push({ cls: String(el.className || el.tagName).slice(0, 60),
        w: Math.round(r.width), cw: el.clientWidth, sw: el.scrollWidth,
        minw: cs.minWidth, disp: cs.display, cols: cs.gridTemplateColumns.slice(0, 46) })
      if (out.chain.length > 9) break
    }
    return JSON.stringify(out)
  })()`,
  returnByValue: true,
})
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync('/tmp/openui-render-verify.png', Buffer.from(shot.result.data, 'base64'))

console.log('=== render diagnostics ===\n' + (title.result?.result?.value ?? '(none)'))
console.log('\n=== frame DOM ===\n' + (detail.result?.result?.value ?? '(none)'))
console.log('\n=== horizontal overflow ===\n' + (overflow.result?.result?.value ?? '(none)'))
console.log('\n=== browser console / log ===\n' + (logs.length ? logs.join('\n') : '(nothing logged)'))
console.log('\nscreenshot: /tmp/openui-render-verify.png')
socket.close(); chrome.kill('SIGKILL'); server.close(); process.exit(0)
