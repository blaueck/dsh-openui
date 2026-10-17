/**
 * Pure OpenUI card descriptor shared by the tool (narrowing at execute time),
 * the browser card (narrowing at render time) and the specs. No I/O and no DOM,
 * so both halves and vitest load it unchanged.
 *
 * The descriptor inlines the whole program: the model already wrote it as the
 * tool argument, and inlining it means replay rebuilds the card from the
 * session log instead of re-reading the copy the tool also writes.
 *
 * @module @blaueck/dsh-openui/meta
 */

import { parseComponentSnapshot, type CustomComponent } from './registry.ts'

/**
 * Wire name of the tool and the key of the toolview that renders its cards.
 * Lives in this pure module so the browser half can import it without pulling
 * the node-side tool implementation into the client bundle.
 */
export const OPENUI_TOOL_NAME = 'openui'

/** Width intent of one OpenUI card. */
export type OpenUiMode = 'inline' | 'wide'

/** What one `openui` call does: render a program, or patch one already rendered. */
export type OpenUiAction = 'create' | 'update'

/** One persisted descriptor for an OpenUI Lang card. */
export interface OpenUiMeta {
  /** Discriminant for consumers sharing the meta channel. */
  kind: 'openui'
  /** Render-intent discriminator: this card is an OpenUI Lang surface. */
  render: 'openui-lang'
  /** The validated program, inlined so replay never re-reads the card file. */
  source: string
  /** Concise human title shown in the card header. */
  title: string
  /** Width intent; `wide` asks the card for the expanded inline surface. */
  mode: OpenUiMode
  /** Session-relative or absolute source path, kept for provenance display. */
  path: string
  /** Catalog the program was validated against, e.g. `@openuidev/react-ui/genui-lib@0.18.0`. */
  libraryId: string
  /**
   * Tool names the program passes to `Query()`, resolved at validation time on
   * the host. The frame attributes each incoming tool call to a read or a write
   * from these two lists, because the renderer's provider carries no statement
   * identity and its parse callback arrives after the first queries have run.
   * Absent on cards logged before this field existed; the frame then declines to
   * the write allowlist, which is the stricter side.
   */
  readTools: string[]
  /** Tool names the program passes to `Mutation()`, resolved the same way. */
  writeTools: string[]
  /**
   * Definitions of the registered components this card used, snapshotted at
   * render time. Replay must not depend on the live registry: a component
   * removed or edited later would otherwise rewrite a card already in the
   * transcript. Absent for cards written before the feature, and for nested
   * dispatches whose meta is rebuilt from arguments; the browser half then falls
   * back to the registry it fetched.
   */
  components?: readonly CustomComponent[]
}

/**
 * Narrow one persisted `tool/result` meta value to an {@link OpenUiMeta}.
 *
 * Wire data cannot be trusted to match the compiled shape — an older or newer
 * host may have logged it — so a mismatch declines to `undefined` and the
 * caller falls back to the generic presentation instead of throwing on replay.
 * @param meta - the raw persisted meta value.
 * @returns the narrowed descriptor, or `undefined` for the generic path.
 */
export function openUiMetaFrom(meta: unknown): OpenUiMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const record = meta as Record<string, unknown>
  if (record['kind'] !== 'openui' || record['render'] !== 'openui-lang') return undefined
  const { title, path, libraryId, source } = record
  const mode = record['mode']
  if (typeof title !== 'string' || typeof path !== 'string' || typeof source !== 'string') return undefined
  if (source.trim().length === 0) return undefined
  if (mode !== 'inline' && mode !== 'wide') return undefined
  const components = parseComponentSnapshot(record['components'])
  return {
    kind: 'openui',
    render: 'openui-lang',
    source,
    title,
    mode,
    path,
    libraryId: typeof libraryId === 'string' ? libraryId : '',
    readTools: nameList(record['readTools']),
    writeTools: nameList(record['writeTools']),
    ...components === undefined ? {} : { components },
  }
}

/**
 * Read a tool-name list, tolerating a log written before the field existed.
 *
 * An absent or malformed list yields `[]`, which makes the frame decline to the
 * write allowlist — the stricter side — rather than silently treating an
 * unknown call as a harmless read.
 * @param value - the raw persisted value.
 * @returns the names, or an empty list.
 */
function nameList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
}

/**
 * Rebuild a descriptor from the call's own arguments when persisted meta is
 * missing. Nested dispatches (`run_code` / PTC) never project presentation
 * meta, but they do log `arguments`, and for a create the program is the whole
 * payload — unlike a patch, which needs the card it addresses.
 *
 * Incomplete streaming JSON is not parsed via throw/catch: only a trailing `}`
 * is treated as complete, so a half-arrived program declines rather than
 * mounting a partial surface.
 * @param argsRaw - running `block.argsRaw` or settled `block.call.argsRaw`.
 * @returns a card descriptor, or `undefined` to keep the quiet fallback.
 */
export function openUiMetaFromArgs(argsRaw: unknown): OpenUiMeta | undefined {
  const complete = parseCompleteArgs(argsRaw)
  if (complete === undefined) return undefined
  const source = complete['source']
  if (typeof source !== 'string' || source.trim().length === 0) return undefined
  if (complete['action'] === 'update') return undefined
  const mode = complete['mode']
  if (mode !== undefined && mode !== 'inline' && mode !== 'wide') return undefined
  const title = complete['title']
  return {
    kind: 'openui',
    render: 'openui-lang',
    source,
    title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : 'OpenUI',
    mode: mode === 'wide' ? 'wide' : 'inline',
    path: typeof complete['path'] === 'string' ? complete['path'] : '',
    libraryId: '',
    // This path rebuilds a card from arguments alone — a nested dispatch, or a
    // call still running — so the host's parse is not available. Empty lists
    // mean "unknown": the frame then falls back to the statement sets it reads
    // from the renderer's own parse callback, and to the write allowlist if even
    // that has not arrived yet.
    readTools: [],
    writeTools: [],
  }
}

/**
 * Read the growing `source` (or `patch`) string out of a partially-arrived
 * argument object, so a card can paint while the program is still streaming.
 *
 * The prefix is not valid JSON yet, so this scans for the key and then decodes
 * the JSON string literal that follows, tolerating an unterminated one. A
 * value that has not started arriving yet yields `undefined`.
 * @param argsRaw - the accumulated raw argument text.
 * @param keys - keys to try, in order.
 * @returns the decoded prefix, or `undefined` when nothing has arrived.
 */
export function openUiSourcePrefix(argsRaw: unknown, keys: readonly string[] = ['source', 'patch']): string | undefined {
  if (typeof argsRaw !== 'string' || argsRaw.length === 0) return undefined
  let best: { at: number; text: string } | undefined
  for (const key of keys) {
    const found = readStringValue(argsRaw, key)
    if (found === undefined) continue
    // The earliest key in the argument text wins: that is the one the model is
    // currently streaming, since arguments are written in schema order.
    if (best === undefined || found.at < best.at) best = found
  }
  if (best === undefined) return undefined
  return best.text.length === 0 ? undefined : best.text
}

/**
 * Locate `"<key>"` in the raw text and decode the JSON string literal after it.
 * @param raw - accumulated argument text.
 * @param key - the argument name to read.
 * @returns the decoded text and the key's offset, or `undefined`.
 */
function readStringValue(raw: string, key: string): { at: number; text: string } | undefined {
  const at = raw.indexOf(`"${key}"`)
  if (at === -1) return undefined
  let index = at + key.length + 2
  while (index < raw.length && raw[index] !== ':') index += 1
  if (index >= raw.length) return undefined
  index += 1
  while (index < raw.length && isSpace(raw[index]!)) index += 1
  if (index >= raw.length || raw[index] !== '"') return undefined
  index += 1
  return { at, text: decodeJsonStringPrefix(raw, index) }
}

/**
 * Decode a JSON string body from `start`, stopping at the closing quote or at
 * the end of the input (an unterminated literal is the normal streaming case).
 * @param raw - the containing text.
 * @param start - index of the first character after the opening quote.
 * @returns the decoded value.
 */
function decodeJsonStringPrefix(raw: string, start: number): string {
  let out = ''
  let index = start
  while (index < raw.length) {
    const ch = raw[index]!
    if (ch === '"') break
    if (ch !== '\\') {
      out += ch
      index += 1
      continue
    }
    const next = raw[index + 1]
    if (next === undefined) break
    switch (next) {
      case 'n': out += '\n'; index += 2; break
      case 't': out += '\t'; index += 2; break
      case 'r': out += '\r'; index += 2; break
      case 'b': out += '\b'; index += 2; break
      case 'f': out += '\f'; index += 2; break
      case '"': out += '"'; index += 2; break
      case '\\': out += '\\'; index += 2; break
      case '/': out += '/'; index += 2; break
      case 'u': {
        const hex = raw.slice(index + 2, index + 6)
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/u.test(hex)) {
          // The escape itself is still streaming; stop and let the next
          // argument snapshot resume from a longer prefix.
          return out
        }
        out += String.fromCharCode(Number.parseInt(hex, 16))
        index += 6
        break
      }
      default: out += next; index += 2; break
    }
  }
  return out
}

/**
 * Recover the card path a nested `openui` result reported.
 *
 * A nested dispatch (PTC) logs the call's own `arguments` and the result
 * `content`, never the persisted `presentationMeta` that names the card path. A
 * create's arguments carry the program but not the name the tool chose, and a
 * later `update` addresses the card by exactly that name — so without this read
 * a nested create is unaddressable and its updates cannot be resolved.
 * @param content - a dispatch event's `content` blocks (or one text string).
 * @returns the path, or undefined when the text is not the tool's confirmation.
 */
export function openUiPathFromText(content: unknown): string | undefined {
  const blocks: unknown[] = Array.isArray(content) ? content : [content]
  for (const block of blocks) {
    const text = typeof block === 'string'
      ? block
      : typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : undefined
    if (text === undefined) continue
    const path = /(?:copy at|updated card at) ([^)\n]+)/u.exec(text)?.[1]?.trim()
    if (path !== undefined && path.length > 0) return path
  }
  return undefined
}

/**
 * Accept only a complete JSON object, gated on a trailing `}` so a streaming
 * prefix never enters `JSON.parse`.
 * @param raw - accumulated argument text.
 * @returns the object, or `undefined` when the prefix is incomplete or illegal.
 */
function parseCompleteArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let end = raw.length
  while (end > 0 && isSpace(raw[end - 1]!)) end -= 1
  if (end === 0 || raw[end - 1] !== '}') return undefined
  try {
    const parsed: unknown = JSON.parse(raw.slice(0, end))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Whether one character is JSON insignificant whitespace.
 * @param ch - the character.
 * @returns true for space, tab, newline or carriage return.
 */
function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}
