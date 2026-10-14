/**
 * The wire contract between an OpenUI card and the host.
 *
 * These types live in their own module on purpose. The Typert generator refuses
 * a Remote boundary type that is not exported from a **public non-root** subpath
 * ("must be exported from a public non-root type subpath"), because the
 * declaration it emits for the browser half has to name the type by import, and
 * the package root is the plugin entry — importing it from the generated client
 * face would be circular. So this module is its own export,
 * `@blaueck/dsh-openui/protocol`, and both halves name the types from there.
 *
 * @module @blaueck/dsh-openui/protocol
 */

/**
 * One JSON value — the only shape that may cross a Remote boundary.
 *
 * Deliberately spelled out rather than `unknown`: the generator validates every
 * boundary and refuses unconstrained `any`/`unknown` data outright, because a
 * boundary it cannot project to a Zod schema is a boundary it cannot check. This
 * is exactly what JSON transport carries, so it loses nothing.
 */
export type RemoteJson =
  | string
  | number
  | boolean
  | null
  | RemoteJson[]
  | { readonly [key: string]: RemoteJson }

/** Which side of the allowlist a card call is checked against. */
export type RemoteCallKind = 'query' | 'mutation'

/** What one card-initiated tool call returns over the wire. */
export interface ToolCallReply {
  /** Whether the tool ran and its value was accepted. */
  readonly ok: boolean
  /** The tool's value, size-checked. Absent on failure. */
  readonly value?: RemoteJson
  /** Human-readable failure reason, phrased for the card. Absent on success. */
  readonly error?: string
  /** Milliseconds spent inside the tool. */
  readonly elapsedMs: number
}

/** What a card is allowed to call, so the browser half can pre-flight a program. */
export interface ToolCatalogReply {
  /** Tool names a `Query()` may call. */
  readonly query: string[]
  /** Tool names a `Mutation()` may call. */
  readonly mutation: string[]
}
