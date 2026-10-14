/**
 * The frame document: the security boundary, the pinned runtime, and the
 * protocol both halves agree on.
 */

import { describe, expect, it } from 'vitest'
import { FRAME_CSS } from '../src/frame-css.ts'
import {
  buildFrameDoc,
  FRAME_ACTION,
  FRAME_CSP,
  FRAME_HEIGHT,
  FRAME_READY,
  FRAME_SET,
  FRAME_TOKEN_FIELD,
  FRAME_TOOLCALL,
  FRAME_TOOLRESULT,
  OPENUI_FRAME_MOUNT_ID,
  OPENUI_GLOBAL,
  OPENUI_RUNTIME,
} from '../src/shell.ts'

const DOC = buildFrameDoc({ token: 'call-1', css: FRAME_CSS })

describe('buildFrameDoc', () => {
  it('mounts into the documented id', () => {
    expect(DOC).toContain(`id="${OPENUI_FRAME_MOUNT_ID}"`)
  })

  it('carries the CSP that confines the frame', () => {
    expect(DOC).toContain('http-equiv="Content-Security-Policy"')
    expect(FRAME_CSP).toContain("default-src 'none'")
    expect(FRAME_CSP).toContain('https://cdn.jsdelivr.net')
    // The component library reaches the frame through react-syntax-highlighter,
    // whose refractor dependency evaluates at module init; without this it
    // throws and the card stays blank.
    expect(FRAME_CSP).toContain("'unsafe-eval'")
    // Still exactly one network origin, and no nested frame or form post.
    expect(FRAME_CSP).toContain("frame-src 'none'")
    expect(FRAME_CSP).toContain("form-action 'none'")
  })

  it('pins the runtime bundle and stylesheet at exact versions', () => {
    for (const url of Object.values(OPENUI_RUNTIME)) {
      expect(url).toMatch(/@\d+\.\d+\.\d+/u)
      expect(DOC).toContain(url)
    }
  })

  it('loads one bundled runtime instead of a CDN module graph', () => {
    // This is the load-bearing decision of the whole frame. Importing React and
    // the renderer as separate `+esm` modules gave the page two React instances
    // (react-dom/client rewrites its `^19.3.0` peer to /npm/react@%5E19.3.0/+esm,
    // react-lang to /npm/react@19.3.0/+esm), and the renderer threw
    // "Cannot read properties of null (reading 'useInsertionEffect')".
    expect(OPENUI_RUNTIME).toEqual({
      bundle: 'https://cdn.jsdelivr.net/npm/@openuidev/browser-bundle@0.2.0/dist/openui-bundle.min.js',
      styles: 'https://cdn.jsdelivr.net/npm/@openuidev/browser-bundle@0.2.0/dist/openui-styles.css',
    })
    expect(DOC).toContain(`<script src="${OPENUI_RUNTIME.bundle}"></script>`)
    expect(DOC).toContain(`<link rel="stylesheet" href="${OPENUI_RUNTIME.styles}">`)
    // No dynamic import and no bare `react` specifier may come back.
    expect(DOC).not.toContain('await import(')
    expect(DOC).not.toContain('"+esm"')
  })

  it('reads the bundle global the bundle actually installs', () => {
    expect(OPENUI_GLOBAL).toBe('__OpenUI')
    expect(DOC).toContain('window[GLOBAL_NAME]')
    // The bundle exposes exactly these; the frame must use the chat library,
    // because that is the catalog the node half validates against.
    expect(DOC).toContain('api.openuiChatLibrary')
    expect(DOC).toContain('api.createRoot')
    expect(DOC).toContain('api.Renderer')
    expect(DOC).not.toContain('api.openuiLibrary')
  })

  it('tags the document with this card token so frames cannot cross-talk', () => {
    expect(DOC).toContain(JSON.stringify('call-1'))
    expect(DOC).toContain(FRAME_TOKEN_FIELD)
  })

  it('names the protocol both halves agree on', () => {
    expect(FRAME_READY).toBe('ready')
    expect(FRAME_HEIGHT).toBe('height')
    expect(FRAME_ACTION).toBe('action')
    expect(FRAME_SET).toBe('set')
    // The frame posts the three it originates and accepts exactly one.
    expect(DOC).toContain("send('ready'")
    expect(DOC).toContain("send('height'")
    expect(DOC).toContain("send('action'")
    expect(DOC).toContain("data.type !== 'set'")
  })

  it('inlines the stylesheet rather than loading one', () => {
    expect(DOC).toContain('--openui-background')
    expect(DOC).toContain('--dsh-openui-fg')
  })

  it('escapes program text so a program cannot close the script block', () => {
    const hostile = buildFrameDoc({ token: '</script><script>alert(1)</script>', css: FRAME_CSS })
    expect(hostile).not.toContain('</script><script>alert(1)')
    expect(hostile).toContain('\\u003c/script>')
  })

  it('announces boot before touching the runtime, so a blocked script is distinguishable', () => {
    const bootAt = DOC.indexOf("send('boot'")
    const globalAt = DOC.indexOf('window[GLOBAL_NAME]')
    expect(bootAt).toBeGreaterThan(-1)
    expect(globalAt).toBeGreaterThan(-1)
    expect(bootAt).toBeLessThan(globalAt)
  })

  it('names which piece is missing instead of a bare error', () => {
    expect(DOC).toContain("'the bundle did not install window.'")
    expect(DOC).toContain("'the component library export is missing'")
    expect(DOC).toContain("'the renderer export is missing'")
  })

  it('ignores an empty error list, which the renderer reports on first paint', () => {
    // Relaying it would print "the program could not be parsed" beneath a card
    // that in fact rendered every component.
    expect(DOC).toContain('if (!errors || !errors.length) return;')
  })
})

describe('FRAME_CSS', () => {
  it('bridges the palette through the bridge properties the card sets', () => {
    for (const name of [
      '--dsh-openui-bg',
      '--dsh-openui-fg',
      '--dsh-openui-brand',
      '--dsh-openui-border',
      '--dsh-openui-danger',
    ]) {
      expect(FRAME_CSS).toContain(name)
    }
  })

  it('maps onto the tokens the component library reads', () => {
    for (const name of [
      '--openui-background',
      '--openui-text-neutral-primary',
      '--openui-interactive-accent-default',
      '--openui-sunk',
    ]) {
      expect(FRAME_CSS).toContain(name)
    }
  })

  it('derives the translucent surfaces so one rule is right in both appearances', () => {
    expect(FRAME_CSS).toContain('color-mix(in oklab, var(--dsh-openui-fg) 4%, transparent)')
  })

  it('follows the same appearance signal the library switches on', () => {
    // The library flips its own palette inside `@media (prefers-color-scheme:
    // dark)`, which a `color-scheme` value cannot override. Pinning the frame to
    // one appearance would let the library pick dark text while the fallbacks
    // stayed light — white text on a white card.
    expect(FRAME_CSS).toContain('color-scheme: light dark')
  })

  it('paints the host base surface so a stalled frame is never a foreign canvas', () => {
    // A transparent viewport is what turns a frame that has not booted yet into
    // an unexplained dark rectangle.
    expect(FRAME_CSS).toContain('background: var(--dsh-openui-bg)')
  })

  it('declares the opaque html background after the shared block that would win on source order', () => {
    const shared = FRAME_CSS.indexOf('html, body {')
    const htmlRule = FRAME_CSS.indexOf('\nhtml {')
    expect(shared).toBeGreaterThan(-1)
    expect(htmlRule).toBeGreaterThan(shared)
    const htmlBlock = FRAME_CSS.slice(htmlRule, FRAME_CSS.indexOf('}', htmlRule))
    expect(htmlBlock).toContain('background: var(--dsh-openui-bg)')
    // Any later `html, …` rule resetting the background would undo it again.
    expect(FRAME_CSS.indexOf('html, body {', shared + 1)).toBe(-1)
    expect(FRAME_CSS).toContain('body {\n  background-color: transparent;')
  })
})

describe('card-initiated tool calls', () => {
  it('names the two extra protocol messages', () => {
    expect(FRAME_TOOLCALL).toBe('toolcall')
    expect(FRAME_TOOLRESULT).toBe('toolresult')
    expect(DOC).toContain("send('toolcall'")
    expect(DOC).toContain("data.type === 'toolresult'")
  })

  it('gives the renderer a tool provider and the parse hook that attributes calls', () => {
    // The provider carries no statement identity, so the frame can only tell a
    // Query from a Mutation by reading the parsed program.
    expect(DOC).toContain('structuredContent: value')
    expect(DOC).toContain('toolProvider: {')
    expect(DOC).toContain('onParseResult: trackProgramTools')
    expect(DOC).toContain('result.queryStatements')
    expect(DOC).toContain('result.mutationStatements')
    expect(DOC).toContain("mutationTools[toolName] === true")
    expect(DOC).toContain("queryTools[toolName] === true")
  })

  it('carries the border-box reset the library assumes', () => {
    // openui-styles.css sets border-box on only part of its own rules and leaves
    // the rest at content-box, including .openui-overview-card, which combines
    // width:100% with padding. Without this reset that card renders one padding
    // wider than its grid track and the whole card scrolls sideways.
    expect(FRAME_CSS).toContain('box-sizing: border-box')
    expect(FRAME_CSS).toMatch(/\*,\s*\*::before,\s*\*::after/)
  })

  it('prefers the host\'s parse over the frame\'s own when both are present', () => {
    // The host parsed the program before the card mounted, so its lists cannot
    // lose a race the way the frame's parse callback can.
    const from = DOC.indexOf('function callKind')
    const body = DOC.slice(from, DOC.indexOf('function callTool', from))
    expect(body.indexOf('declaredWrite[toolName]')).toBeLessThan(body.indexOf('mutationTools[toolName]'))
    expect(body.indexOf('declaredRead[toolName]')).toBeLessThan(body.indexOf('queryTools[toolName]'))
    expect(DOC).toContain('declaredRead = nameSet(data.readTools)')
    expect(DOC).toContain('declaredWrite = nameSet(data.writeTools)')
  })

  it('attributes an unrecognised tool name to the stricter side', () => {
    // A name that is not a literal, or appears in neither set, must not be
    // treated as a harmless read: the mutation check runs first and the fallback
    // is `mutation`.
    const from = DOC.indexOf('function callKind')
    const body = DOC.slice(from, DOC.indexOf('function callTool', from))
    expect(body.length).toBeGreaterThan(0)
    expect(body.indexOf("mutationTools[toolName] === true")).toBeLessThan(
      body.indexOf("queryTools[toolName] === true"),
    )
    const returns = [...body.matchAll(/return\s+'([a-z]+)'/gu)].map(match => match[1])
    expect(returns.at(-1)).toBe('mutation')
  })

  it('rejects an unanswered call on a timer instead of leaving it pending', () => {
    expect(DOC).toContain('TOOL_TIMEOUT_MS')
    expect(DOC).toContain('the host did not answer the ')
    expect(DOC).toContain('clearTimeout(entry.timer)')
  })

  it('carries a correlation id so several live queries settle independently', () => {
    expect(DOC).toContain("var id = 'c' + (++callSeq)")
    expect(DOC).toContain('pendingCalls[message.id]')
  })
})
