/**
 * The policy a card-initiated tool call is judged by, with no Cordis and no I/O.
 *
 * Kept apart from the service that applies it so the two decisions that actually
 * matter — may this card call this tool, and is the answer small enough to render
 * — are unit-testable on their own. Everything else in `remote.ts` is plumbing
 * around these two calls.
 *
 * @module @blaueck/dsh-openui/host/policy
 */

import type { RemoteCallKind } from '../protocol.ts'

/** The allowlists and ceilings one deployment configured. */
export interface ToolPolicy {
  /** Tools a `Query()` may call. */
  readonly allowedTools: readonly string[]
  /** Tools a `Mutation()` may call. */
  readonly writableTools: readonly string[]
  /** Byte ceiling on one returned value. */
  readonly maxResultBytes: number
}

/** The verdict on one requested call. */
export type ToolVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

/** The allowlist that governs one call kind. */
function listFor(policy: ToolPolicy, kind: RemoteCallKind): readonly string[] {
  return kind === 'query' ? policy.allowedTools : policy.writableTools
}

/** The allowlist name a refusal should point the operator at. */
function listName(kind: RemoteCallKind): string {
  return kind === 'query' ? 'allowedTools' : 'writableTools'
}

/**
 * Decide whether a card may make one call.
 *
 * Both lists start empty, so an unconfigured deployment refuses everything; that
 * is the intended default rather than an oversight. A refusal names the list to
 * extend, and when the tool is listed on the *other* side it also says so — the
 * usual mistake is a program reaching for `Query()` on a tool the operator
 * authorised only for `Mutation()`, and that is worth one sentence rather than a
 * round of guessing.
 * @param policy - the deployment's allowlists.
 * @param kind - which statement made the call.
 * @param toolName - the tool the program named.
 * @returns whether the call may proceed, and why not when it may not.
 */
export function decideToolCall(policy: ToolPolicy, kind: RemoteCallKind, toolName: string): ToolVerdict {
  if (listFor(policy, kind).includes(toolName)) return { allowed: true }

  const other: RemoteCallKind = kind === 'query' ? 'mutation' : 'query'
  const hint = listFor(policy, other).includes(toolName)
    ? ` It is listed in \`${listName(other)}\` — use ${other === 'query' ? '`Query()`' : '`Mutation()`'} for it.`
    : ''
  return {
    allowed: false,
    reason:
      `\`${toolName}\` is not in the openui \`${listName(kind)}\` allowlist, so cards may not call it.${hint}`,
  }
}

/**
 * Decide whether a tool's value is small enough to hand to a card.
 *
 * An oversized result is refused rather than truncated: a table or chart drawn
 * from a silently shortened array is worse than an error, because the numbers on
 * screen would be wrong without saying so.
 * @param policy - the deployment's ceilings.
 * @param toolName - the tool that answered, named in the reason.
 * @param value - the value the tool returned.
 * @returns undefined when the value fits, otherwise the reason it does not.
 */
export function checkResultSize(policy: ToolPolicy, toolName: string, value: unknown): string | undefined {
  const size = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
  if (size <= policy.maxResultBytes) return undefined
  return `\`${toolName}\` returned ${Math.round(size / 1024)} kB, over the `
    + `${Math.round(policy.maxResultBytes / 1024)} kB ceiling. Narrow the query `
    + '(fewer rows, fewer columns, or an aggregate).'
}
