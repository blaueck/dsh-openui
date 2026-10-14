/**
 * The `openui` toolview: renders an OpenUI Lang program inside
 * `<iframe sandbox="allow-scripts">` with the frame's own CSP.
 * Replay-stable by construction — everything drawn derives from the logged call
 * slice, never from the card file.
 *
 * Unlike a card whose document carries its payload, this frame is built once
 * and then fed: the OpenUI runtime is a React 19 application fetched from a CDN,
 * so remounting it per streamed chunk would re-import the library on every
 * keystroke. Instead the frame announces itself, and every later state — the
 * growing program, the host palette — arrives as a message the mounted renderer
 * re-renders from. That is also what makes the card stream: OpenUI Lang is
 * re-parsed per chunk, so `root` paints before the data behind it has arrived.
 *
 * Theme bridge: the card resolves the host's `--dsw-alias-*` design tokens at
 * render time and sends them into the frame, where the stylesheet maps them onto
 * the `--openui-*` tokens the component library reads; a mutation of the root
 * element's attributes or an OS appearance flip re-resolves and re-sends them.
 *
 * Height: a sandboxed frame's document is unreachable from the parent, so the
 * frame posts its own scroll height (tagged with this call's id) and the card
 * sizes the iframe, capped per mode with internal scrolling past the cap.
 *
 * @module @blaueck/dsh-openui/client/OpenUiCard
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { FRAME_CSS } from '../frame-css.ts'
import { openUiMetaFrom, openUiMetaFromArgs, openUiSourcePrefix, type OpenUiMeta, type OpenUiMode } from '../meta.ts'
import {
  buildFrameDoc,
  FRAME_ACTION,
  FRAME_BOOT,
  FRAME_ERROR,
  FRAME_HEIGHT,
  FRAME_READY,
  FRAME_SET,
  FRAME_TOKEN_FIELD,
  FRAME_TOOLCALL,
  FRAME_TOOLRESULT,
  type FrameSetMessage,
} from '../shell.ts'
import { formatActionSubmission, type FrameAction } from './conversation.ts'
import { observeTheme, resolveTheme } from './theme.ts'

/**
 * Hand one card action to the session the card was rendered in. The title
 * travels with it because only the card knows which surface acted, and the
 * submission names it.
 */
export type ActionHandler = (action: FrameAction, title: string) => void | Promise<void>

/** Iframe height bounds; content beyond the cap scrolls inside the frame. */
const MIN_HEIGHT = 56
const HEIGHT_CAP: Record<OpenUiMode, number> = { inline: 900, wide: 1400 }

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  fontSize: 12,
  opacity: 0.65,
  margin: '2px 0 6px',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  // Without this the row reports the full width of its `nowrap` children as its
  // own minimum, which a grid or flex parent then honours by widening the track
  // past the conversation column and scrolling the page sideways.
  minWidth: 0,
}

/**
 * The card's own title. `nowrap` is inherited from the header, so without a zero
 * minimum and an ellipsis this is the single widest thing in the card: it is the
 * min-content width of the whole row, and of everything above it.
 */
const titleStyle: CSSProperties = {
  fontWeight: 500,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

/**
 * The refusal row. A card that could not render has to be readable in full: the
 * message names the offending statement and what would have worked, and a
 * clipped single line hides exactly the part that fixes it.
 */
const errorStyle: CSSProperties = {
  ...headerStyle,
  whiteSpace: 'pre-wrap',
  overflow: 'visible',
  opacity: 1,
  color: 'var(--dsw-alias-state-error-primary, #d33)',
}

const frameStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  // An `<iframe>` is a replaced element with a 300px intrinsic minimum, which a
  // grid or flex parent will happily use as the track's floor. Zeroing it lets
  // the frame follow the column instead of setting a width for it.
  minWidth: 0,
  maxWidth: '100%',
  border: 0,
  background: 'transparent',
  colorScheme: 'normal',
}

/** How far the frame has got. */
export type FrameStatus = 'loading' | 'ready' | 'failed'

/**
 * How long to wait for the frame to finish booting before calling it failed.
 * The first card in a session fetches the whole OpenUI runtime from the CDN, so
 * this is generous; later cards hit the module cache and answer immediately.
 */
const READY_TIMEOUT_MS = 20_000

/**
 * What the frame needs back from one tool call.
 *
 * Deliberately narrower than the host's wire `ToolCallReply`: the frame reads
 * only these three fields, and a client-side failure (no host surface, no
 * session) never had a host round trip to time.
 */
export interface ToolCallResult {
  /** Whether the tool ran and its value was accepted. */
  ok: boolean
  /** The tool's value, already size-checked by the host. */
  value?: unknown
  /** Human-readable failure reason. */
  error?: string
}

/**
 * Run one card-initiated tool call on the host.
 *
 * `kind` is the frame's reading of the statement that made the call — a
 * `Query()` or a `Mutation()` — which is what puts it against the right
 * allowlist. The frame derives it from the program it parsed, not from the
 * provider call, which carries no statement identity.
 */
export type ToolCallHandler = (
  tool: string,
  args: unknown,
  kind: 'query' | 'mutation',
) => Promise<ToolCallResult>

/** The live channel to one call's frame. */
interface FrameChannel {
  /** Attach to the `<iframe>` so the channel can post into it. */
  frameRef: MutableRefObject<HTMLIFrameElement | null>
  /** Height the frame last reported, already clamped. */
  height: number
  /** Boot progress, so a frame that never paints says why instead of sitting blank. */
  status: FrameStatus
  /** Reason the frame failed, when it did. */
  error: string | undefined
  /**
   * Publish one program state to the frame. `readTools`/`writeTools` are the
   * host's parse of the program; omit them only where no host parse exists.
   */
  publish: (
    source: string,
    streaming: boolean,
    tools?: { readTools?: readonly string[]; writeTools?: readonly string[] },
  ) => void
}

/**
 * Open (and keep open) the message channel to one card's frame.
 * @param options - the call id the frame echoes, the sinks, and the mode cap.
 * @returns the channel handle.
 */
function useFrameChannel(options: {
  callId: string
  mode: OpenUiMode
  onAction?: ActionHandler | undefined
  callTool?: ToolCallHandler | undefined
  title: string
}): FrameChannel {
  const { callId, mode, onAction, callTool, title } = options
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const readyRef = useRef(false)
  const stateRef = useRef<{
    source: string
    streaming: boolean
    readTools?: readonly string[]
    writeTools?: readonly string[]
  }>({ source: '', streaming: false })
  // The listener is attached once per call; reading the sinks through refs keeps
  // it from having to be re-attached whenever a parent re-renders.
  const actionRef = useRef(onAction)
  actionRef.current = onAction
  const toolRef = useRef(callTool)
  toolRef.current = callTool
  const titleRef = useRef(title)
  titleRef.current = title
  const [height, setHeight] = useState(MIN_HEIGHT)
  const [status, setStatus] = useState<FrameStatus>('loading')
  const [error, setError] = useState<string | undefined>(undefined)
  // Distinguishes "the inline script never ran" from "the CDN runtime never
  // arrived": the two have different causes and different fixes.
  const bootedRef = useRef(false)

  const [themeTick, setThemeTick] = useState(0)

  /** Send the current program state and palette into the frame. */
  const push = useCallback(() => {
    const target = frameRef.current?.contentWindow
    if (target === null || target === undefined || !readyRef.current) return
    const theme = resolveTheme()
    const message: FrameSetMessage & Record<string, unknown> = {
      [FRAME_TOKEN_FIELD]: callId,
      type: FRAME_SET,
      source: stateRef.current.source,
      streaming: stateRef.current.streaming,
      ...stateRef.current.readTools === undefined ? {} : { readTools: stateRef.current.readTools },
      ...stateRef.current.writeTools === undefined ? {} : { writeTools: stateRef.current.writeTools },
      theme: theme.vars,
      scheme: theme.scheme,
    }
    target.postMessage(message, '*')
  }, [callId])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      // Only this frame may speak for this card, so a sibling card or an
      // unrelated page cannot drive the width or forge an action.
      if (frame === null || event.source !== frame.contentWindow) return
      const data = event.data as Record<string, unknown> | null
      if (data === null || typeof data !== 'object' || data[FRAME_TOKEN_FIELD] !== callId) return
      switch (data['type']) {
        case FRAME_BOOT:
          bootedRef.current = true
          break
        case FRAME_READY:
          readyRef.current = true
          setStatus('ready')
          setError(undefined)
          push()
          break
        case FRAME_ERROR:
          setStatus('failed')
          setError(typeof data['message'] === 'string' ? data['message'] : 'the OpenUI runtime failed to load')
          break
        case FRAME_HEIGHT: {
          const reported = typeof data['height'] === 'number' ? data['height'] : 0
          setHeight(Math.min(Math.max(Math.ceil(reported), MIN_HEIGHT), HEIGHT_CAP[mode]))
          break
        }
        case FRAME_ACTION: {
          const sink = actionRef.current
          const action = data['event'] as FrameAction | undefined
          if (sink !== undefined && action !== undefined) void sink(action, titleRef.current)
          break
        }
        case FRAME_TOOLCALL: {
          // The frame asked for data. Answer on the same channel, tagged with the
          // frame's correlation id, so a card with several live queries settles
          // each promise with its own result.
          const id = data['id']
          const tool = data['tool']
          const reply = (payload: Record<string, unknown>): void => {
            frame.contentWindow?.postMessage(
              { [FRAME_TOKEN_FIELD]: callId, type: FRAME_TOOLRESULT, id, ...payload },
              '*',
            )
          }
          const sink = toolRef.current
          if (sink === undefined || typeof tool !== 'string') {
            reply({ ok: false, error: 'this client cannot run card tool calls' })
            break
          }
          void sink(tool, data['args'], data['kind'] === 'mutation' ? 'mutation' : 'query').then(
            (result) => reply(result.ok
              ? { ok: true, value: result.value }
              : { ok: false, error: result.error ?? 'the tool call failed' }),
            (failure: unknown) => reply({
              ok: false,
              error: failure instanceof Error ? failure.message : String(failure),
            }),
          )
          break
        }
        default:
          break
      }
    }
    window.addEventListener('message', onMessage)
    const stopTheme = observeTheme(document, () => setThemeTick(tick => tick + 1))
    const timer = setTimeout(() => {
      if (readyRef.current) return
      setStatus('failed')
      setError(bootedRef.current
        ? `the OpenUI runtime did not load within ${READY_TIMEOUT_MS / 1000}s — `
          + 'the frame needs network access to cdn.jsdelivr.net'
        : 'the card frame never started — its script was blocked, most likely by the frame CSP')
    }, READY_TIMEOUT_MS)
    return () => {
      window.removeEventListener('message', onMessage)
      stopTheme()
      clearTimeout(timer)
      readyRef.current = false
      bootedRef.current = false
    }
  }, [callId, mode, push])

  const publish = useCallback((
    source: string,
    streaming: boolean,
    tools?: { readTools?: readonly string[]; writeTools?: readonly string[] },
  ) => {
    stateRef.current = { source, streaming, ...tools }
    push()
  }, [push])

  // Re-resolve the palette on a host theme change; the deliberate trigger for
  // the read is the tick, not any value it carries.
  useEffect(() => { push() }, [push, themeTick])

  return { frameRef, height, status, error, publish }
}

/**
 * The card's outermost box. `minWidth: 0` is what keeps a long title from
 * defining this element's minimum and, through it, the width of the row it sits
 * in; `maxWidth` keeps it inside that row even if a parent hands it more.
 */
const cardStyle: CSSProperties = { minWidth: 0, maxWidth: '100%' }

/** Header line plus the sandboxed frame. */
function CardView({ frameRef, height, status, error, title, path, doc }: {
  frameRef: MutableRefObject<HTMLIFrameElement | null>
  height: number
  status: FrameStatus
  error: string | undefined
  title: string
  path: string
  doc: string
}) {
  return (
    <div style={cardStyle}>
      <div style={headerStyle} title={path === '' ? title : path}>
        <span style={titleStyle}>{title}</span>
        {status === 'loading' && <span>· loading the OpenUI runtime…</span>}
        {path !== '' && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{path}</span>}
      </div>
      {/* A frame that never booted must say so: the alternative is a blank box
          with no way to tell a blocked script from an unreachable CDN. */}
      {error !== undefined && <div style={errorStyle}>OpenUI · {error}</div>}
      <iframe
        ref={frameRef}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={title}
        srcDoc={doc}
        style={{ ...frameStyle, height }}
      />
    </div>
  )
}

/**
 * A settled, well-formed card.
 * @param props - the descriptor, the call id and the sinks.
 */
export function OpenUiFrame({ meta, callId, onAction, callTool }: {
  meta: OpenUiMeta
  callId: string
  onAction?: ActionHandler | undefined
  callTool?: ToolCallHandler | undefined
}) {
  const { frameRef, height, status, error, publish } = useFrameChannel({
    callId, mode: meta.mode, onAction, callTool, title: meta.title,
  })
  // The document is built once per call: rebuilding it would remount the frame
  // and re-import the renderer this card is streaming into.
  const doc = useMemo(() => buildFrameDoc({ token: callId, css: FRAME_CSS }), [callId])
  useEffect(() => {
    publish(meta.source, false, { readTools: meta.readTools, writeTools: meta.writeTools })
  }, [publish, meta.source, meta.readTools, meta.writeTools])
  return (
    <CardView
      frameRef={frameRef} height={height} status={status} error={error}
      title={meta.title} path={meta.path} doc={doc}
    />
  )
}

/** A card that is still streaming, driven by the call's own argument prefix. */
export function OpenUiStreamingFrame({ source, callId, title, onAction, callTool }: {
  source: string
  callId: string
  title: string
  onAction?: ActionHandler | undefined
  callTool?: ToolCallHandler | undefined
}) {
  const { frameRef, height, status, error, publish } = useFrameChannel({
    callId, mode: 'inline', onAction, callTool, title,
  })
  const doc = useMemo(() => buildFrameDoc({ token: callId, css: FRAME_CSS }), [callId])
  useEffect(() => { publish(source, true) }, [publish, source])
  return (
    <CardView
      frameRef={frameRef} height={height} status={status} error={error}
      title={title} path="" doc={doc}
    />
  )
}

/** First text line of the durable result content, for the error row. */
function firstResultLine(content: unknown): string {
  if (typeof content === 'string') return content.split('\n')[0] ?? content
  if (!Array.isArray(content)) return 'the program could not be rendered'
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.length > 0) return text.split('\n')[0] ?? text
    }
  }
  return 'the program could not be rendered'
}

/**
 * Read this call's growing program out of the call's own argument prefix.
 * @param block - the phase block, whichever shape the host logged.
 * @returns the raw argument text, or undefined.
 */
function argsRawOf(block: unknown): unknown {
  if (typeof block !== 'object' || block === null) return undefined
  const record = block as { kind?: unknown; argsRaw?: unknown; call?: { argsRaw?: unknown } }
  if ('kind' in record) return record.call?.argsRaw
  return record.argsRaw
}

/**
 * Keyed toolview for the `openui` tool. A call whose arguments are still
 * streaming paints as it grows; when it settles the finished program is handed
 * to the frame that is already painting it. A failed or unreadable result stays
 * a quiet single row.
 * @param props - the atomic view props the host supplies.
 */
export function OpenUiCard(props: ToolCallViewProps & {
  onAction?: ActionHandler | undefined
  callTool?: ToolCallHandler | undefined
}) {
  const { callId, block, onAction, callTool } = props
  const phase = (props as { phase?: string }).phase
  // dsh 0.2 exposes a preparing phase whose block carries no arguments yet; the
  // slot injects this call's own growing argument prefix, and it is empty in
  // every other phase and for a dispatch with no prefix at all.
  const readPartial = (props as { useToolCallArgumentsPartial?: () => string }).useToolCallArgumentsPartial
  const partial = readPartial === undefined ? '' : readPartial()
  const argsRaw = argsRawOf(block)

  if (phase === 'preparing' || (phase === undefined && 'kind' in (block as object))) {
    const source = openUiSourcePrefix(partial) ?? openUiSourcePrefix(argsRaw)
    if (source === undefined) return <div style={headerStyle}>OpenUI · composing…</div>
    return (
      <OpenUiStreamingFrame
        source={source} callId={callId} title="OpenUI" onAction={onAction} callTool={callTool}
      />
    )
  }

  const settled = block as { isError?: boolean; meta?: unknown; content?: unknown }
  if (settled.isError === true) {
    return <div style={errorStyle}>OpenUI · {firstResultLine(settled.content)}</div>
  }
  const meta = openUiMetaFrom(settled.meta) ?? openUiMetaFromArgs(argsRaw)
  if (meta === undefined) {
    return <div style={errorStyle}>{firstResultLine(settled.content)}</div>
  }
  if (phase === 'start') {
    return (
      <OpenUiStreamingFrame
        source={meta.source} callId={callId} title={meta.title} onAction={onAction} callTool={callTool}
      />
    )
  }
  return <OpenUiFrame meta={meta} callId={callId} onAction={onAction} callTool={callTool} />
}

/**
 * Format one action as the user turn the model will read.
 * Re-exported so the registration can bind it without importing the bridge.
 */
export { formatActionSubmission }

