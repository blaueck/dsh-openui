/**
 * Host-facing Remote surface for OpenUI cards.
 *
 * A card runs in an opaque-origin frame and can reach nothing but `postMessage`;
 * the browser half can reach the host, but only through a Typert Remote. This
 * service is that Remote, and it is the one seam through which a model-authored
 * program can ask DSH to run a tool while the card is on screen.
 *
 * ## Why the allowlist is the whole security model
 *
 * The program is model-authored, so the tool name and arguments in a
 * `Query()`/`Mutation()` are whatever the model wrote. Three things make that
 * different from the model simply calling the tool itself:
 *
 * 1. A card re-runs on its own — a `$variable` change or a `refreshInterval`
 *    triggers the call again, with no model turn in between.
 * 2. The result is rendered into the card and never enters the model's context
 *    or the session log, so nothing in the transcript records what was fetched.
 * 3. A `Mutation()` is triggered by a *user* click, so it can write without the
 *    model having decided to at that moment.
 *
 * So neither list is defaulted. `allowedTools` and `writableTools` start empty,
 * and until an operator names a tool here the bridge refuses every call. A
 * mutation additionally runs through the normal tool pipeline, which is where
 * the session's approval policy decides whether to prompt.
 *
 * @module @blaueck/dsh-openui/host/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/**
 * Cordis service key (`openuiRemote`) and Remote namespace (`openui`) are passed
 * to `super()` as *string literals* on purpose: `WorkspaceAnalyzer.gatewayBinding()`
 * reads them syntactically (`stringLiteralValue()`), so an imported constant
 * would fail `pnpm run gen:typert` with "Gateway service key must be a string
 * literal". Keep them inline here — this call site is the single source of truth
 * for the wire name.
 */

import type { RemoteCallKind, RemoteJson, ToolCallReply } from '../protocol.ts'
import { checkResultSize, decideToolCall } from './policy.ts'

/** Deployment limits and allowlists this Remote enforces. */
export interface OpenUiRemoteOptions {
  /** Tools a `Query()` may call. Empty disables querying entirely. */
  readonly allowedTools: readonly string[]
  /** Tools a `Mutation()` may call. Empty disables mutations entirely. */
  readonly writableTools: readonly string[]
  /** Byte ceiling on one returned value; larger results are refused. */
  readonly maxResultBytes: number
  /** Wall-clock ceiling on one tool call. */
  readonly callTimeoutMs: number
}

/** Structural view of the `agents` service; avoids depending on its Context merge. */
interface AgentsFace {
  get(id: string): unknown
}

/** Structural view of the `tools` service this service needs. */
interface ToolsFace {
  execute(exec: {
    callId: ReturnType<typeof ToolCallId>
    name: string
    arguments: unknown
    agent?: Agent
    signal: AbortSignal
  }): Promise<ToolExecutionResult>
}

/** The Remote surface a browser half mounts as `ctx.remote.openui`. */
export class OpenUiRemote extends TypertRemoteService<never> {
  /**
   * Cordis hands a service out through a Proxy, and a `#private` field is not
   * reachable through one: every method that touched `this.#options` threw
   * "Cannot read private member from an object whose class did not declare it".
   * A TypeScript `private` field erases to an ordinary property and survives the
   * proxy, which is what this needs.
   */
  private readonly options: OpenUiRemoteOptions
  private calls = 0

  /**
   * @param ctx - registrant context.
   * @param options - allowlists and limits, resolved from the plugin Config.
   */
  constructor(ctx: Context, options: OpenUiRemoteOptions) {
    super(ctx, 'openuiRemote', { namespace: 'openui' })
    this.options = options
  }

  /**
   * Report what a card is allowed to call, so the browser half can tell the
   * renderer which tool names exist instead of failing every one at call time.
   * @returns the two allowlists, as configured.
   */
  @Remote('catalog')
  async catalog(): Promise<{ query: string[]; mutation: string[] }> {
    return {
      query: [...this.options.allowedTools],
      mutation: [...this.options.writableTools],
    }
  }

  /**
   * Run one tool on behalf of a card.
   *
   * The session named here comes from the slot props the host rendered the card
   * with, never from the frame, so a program cannot address another session.
   * @param sessionId - the session the card was rendered in.
   * @param toolName - the tool the program named.
   * @param args - the arguments the program supplied.
   * @param kind - `query` for a read, `mutation` for a write.
   * @returns the tool's value, or a refusal/failure reason.
   */
  @Remote('call')
  async call(sessionId: string, toolName: string, args: RemoteJson, kind: RemoteCallKind): Promise<ToolCallReply> {
    const started = Date.now()
    const refuse = (error: string): ToolCallReply => ({ ok: false, error, elapsedMs: Date.now() - started })

    if (typeof sessionId !== 'string' || sessionId.length === 0) return refuse('the card is not bound to a session')
    if (typeof toolName !== 'string' || toolName.length === 0) return refuse('no tool name was given')
    if (kind !== 'query' && kind !== 'mutation') return refuse(`unknown call kind "${String(kind)}"`)

    const verdict = decideToolCall(this.options, kind, toolName)
    if (!verdict.allowed) return refuse(verdict.reason)

    const agent = this.resolveAgent(sessionId)
    if (agent === undefined) return refuse('this session is no longer running')

    const tools = this.ctx.get('tools') as ToolsFace | undefined
    if (typeof tools?.execute !== 'function') return refuse('this host cannot run tools')

    // A synthetic id keeps card-initiated calls distinguishable in any observer
    // that logs call identity; it is never paired with a `tool/result` event.
    const callId = ToolCallId(`openui:${++this.calls}:${toolName}`)
    let result: ToolExecutionResult
    try {
      result = await tools.execute({
        callId,
        name: toolName,
        arguments: args,
        ...(agent === undefined ? {} : { agent }),
        signal: AbortSignal.timeout(this.options.callTimeoutMs),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return refuse(`\`${toolName}\` failed: ${detail}`)
    }

    if (result.isError) return refuse(`\`${toolName}\` failed: ${flatten(result.content)}`)

    // `tools.execute` types its value as `unknown`; a tool result crosses the
    // Remote boundary as JSON, which is the contract {@link RemoteJson} names.
    const value = result.value as RemoteJson
    const oversize = checkResultSize(this.options, toolName, value)
    if (oversize !== undefined) return refuse(oversize)
    return { ok: true, value, elapsedMs: Date.now() - started }
  }

  /**
   * Resolve the agent a card's session belongs to.
   * @param sessionId - the session the card was rendered in.
   * @returns the agent, or undefined when the session is gone.
   */
  private resolveAgent(sessionId: string): Agent | undefined {
    const agents = this.ctx.get('agents') as AgentsFace | undefined
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    return agent as Agent | undefined
  }

}

/**
 * Flatten result content blocks into one line for a failure message.
 * @param content - the tool's model-facing content.
 * @returns the joined text, truncated.
 */
function flatten(content: readonly { type?: string; text?: string }[]): string {
  const text = content
    .map(block => (typeof block.text === 'string' ? block.text : `[${block.type ?? 'block'}]`))
    .join(' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()
  return text.length === 0 ? 'no reason given' : text.slice(0, 400)
}
