/**
 * dsh-openui, browser half.
 *
 * Two registrations:
 *
 * 1. The OpenUI card under the `openui` key of the atomic toolview hole. Clients
 *    without this half degrade to the tool's generic result text by the
 *    documented toolview fallback.
 * 2. The turn tail, which re-shows a finished turn's cards under its closing
 *    answer — the fold hides the tool row, and the card is the turn's output
 *    rather than its process.
 *
 * A card's action (`@ToAssistant(...)` on a button, or a form submit) is sent
 * through the host's session-scoped conversation service, bound to the session
 * the card was rendered in — the frame itself cannot reach the session, so this
 * half is the only path out.
 *
 * @module @blaueck/dsh-openui/client
 */

import { useCallback } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.slots` Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `tool.call.toolview` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: pulls the `conversation.chat.turnTail` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
// The generated Client contribution for this package's own Remote, plus the
// declaration merge that puts `openui` on `ctx.remote`.
import { TYPERT_REMOTE } from '@blaueck/dsh-openui/remote'
import {
  OpenUiCard,
  formatActionSubmission,
  type ActionHandler,
  type ToolCallHandler,
  type ToolCallResult,
} from './OpenUiCard.tsx'
import { OpenUiTurnCards } from './TurnCards.tsx'
import { sendCardAction, type FrameAction } from './conversation.ts'
import { turnCardsDefinition } from './turn-cards.ts'
import type { ToolCallReply } from '../protocol.ts'
import { OPENUI_TOOL_NAME } from '../meta.ts'

export const name = '@blaueck/dsh-openui'

// `remote` is declared statically because that is the only form the shipped
// Remote consumers use, and a dynamic `ctx.inject(['remote'], …)` did not in fact
// grant access on the client — reading it there still threw
// `cannot get property "remote" without inject`. `remote.openui` is deliberately
// NOT listed: this plugin is what mounts that namespace, so waiting on it up
// front would deadlock.
export const inject = ['slots', 'remote']

/** The `remote` service face this package needs, read through optional `get`. */
interface RemoteFace {
  /** Mount one generated Host-for-Client contribution in the caller's fiber. */
  $mount(contribution: unknown): Promise<() => void>
}

/** The `openui` namespace this package's Remote contribution mounts. */
interface OpenUiRemoteFace {
  /**
   * The generated signature wraps the business result in the protocol's own
   * envelope, so a transport-level failure and a refused tool call arrive on two
   * different branches and are unwrapped separately below.
   */
  call(
    sessionId: string,
    tool: string,
    args: unknown,
    kind: 'query' | 'mutation',
  ): Promise<{ ok: true; value: ToolCallReply } | { ok: false; error: { message?: string } }>
}

/**
 * The session id every session-scoped slot component receives from the
 * renderer's standard props. Read structurally: the type merge lives in a
 * package this bundle does not depend on, while the value is on the wire.
 * @param props - the slot component's props.
 * @returns the session id, or undefined outside a session scope.
 */
function sessionIdOf(props: unknown): unknown {
  return typeof props === 'object' && props !== null ? (props as { sessionId?: unknown }).sessionId : undefined
}

/**
 * Resolve this package's mounted Remote namespace.
 *
 * The namespace has to be mounted before it can be read, and reading it is
 * guarded by Cordis — `cannot get property "remote.openui" without inject` — so
 * this walks the only route that exists for a third-party package:
 *
 * 1. `remote` is a **static** dependency (see {@link inject}), which is what
 *    makes `ctx.remote.$mount(…)` readable at all. A dynamic `ctx.inject`
 *    callback did not grant that access on the client.
 * 2. `remote.openui` cannot be static: this plugin is what mounts it, so
 *    declaring it up front would wait on a service this package creates. It is
 *    reached through a dynamic injection instead — and directly, in case
 *    declaring `remote` already covers its properties. Both are attempted, since
 *    which one the guard accepts is not documented for namespaced services.
 * @param ctx - client root context.
 * @returns a resolver the tool-call sink awaits before every call.
 */
function createRemoteResolver(ctx: ClientContext): () =>
Promise<{ face: OpenUiRemoteFace; error?: undefined } | { face?: undefined; error: string }> {
  let face: OpenUiRemoteFace | undefined
  let failure: string | undefined
  let declared: Promise<void> | undefined

  const holder = ctx as unknown as {
    remote: RemoteFace & { openui?: OpenUiRemoteFace }
    inject(deps: string[], callback: (scope: unknown) => void): unknown
  }

  const mounted = Promise.resolve()
    .then(() => holder.remote.$mount(TYPERT_REMOTE))
    .then(
      () => undefined,
      (reason: unknown) => {
        failure = `mounting the openui Remote failed: ${reason instanceof Error ? reason.message : String(reason)}`
      },
    )

  // Path A: read it from a scope that declared the namespace.
  try {
    holder.inject(['remote.openui'], (scope) => {
      declared = mounted.then(() => {
        const namespace = (scope as { remote: { openui?: OpenUiRemoteFace } }).remote.openui
        if (namespace === undefined) failure = 'the openui Remote mounted but exposed no openui namespace'
        else face = namespace
      })
    })
  } catch (reason) {
    failure = `declaring the openui Remote namespace failed: ${reason instanceof Error ? reason.message : String(reason)}`
  }

  return async () => {
    if (face !== undefined) return { face }
    await mounted
    // Path B: declaring `remote` may already be enough to read its namespace.
    if (face === undefined) {
      try {
        face = holder.remote.openui
      } catch { /* guarded; path A is the one that will carry it */ }
    }
    if (face === undefined && declared !== undefined) await declared
    if (face !== undefined) return { face }
    return { error: failure ?? 'the openui Remote did not mount' }
  }
}

/**
 * Bind a card's data requests to this package's host Remote.
 *
 * The session travels from the slot props, never from the frame, so a program
 * cannot address a session the card was not rendered in. The allowlists are
 * enforced on the host, so an unknown tool name fails there rather than here.
 * @param ctx - client root context, which owns the `remote` lookup.
 * @param props - the slot component's props, carrying `sessionId`.
 * @param resolveRemote - resolves (and if needed mounts) the Remote namespace.
 * @returns the stable tool-call sink.
 */
function useToolCallHandler(
  ctx: ClientContext,
  props: unknown,
  resolveRemote: ReturnType<typeof createRemoteResolver>,
): ToolCallHandler {
  const sessionId = sessionIdOf(props)
  return useCallback(async (tool: string, args: unknown, kind: 'query' | 'mutation'): Promise<ToolCallResult> => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, error: 'the card is not bound to a session' }
    }
    const resolved = await resolveRemote()
    if (resolved.face === undefined) return { ok: false, error: resolved.error }
    try {
      const result = await resolved.face.call(sessionId, tool, args, kind)
      if (!result.ok) {
        return { ok: false, error: result.error.message ?? 'the host refused the call' }
      }
      const reply = result.value
      return reply.ok
        ? { ok: true, value: reply.value }
        : { ok: false, error: reply.error ?? 'the tool call failed' }
    } catch (failure) {
      return { ok: false, error: failure instanceof Error ? failure.message : String(failure) }
    }
  }, [resolveRemote, sessionId])
}

/** The Conversation event registry, where the host has one. */
interface ConversationEvents {
  register(definition: ConversationNodeDefinition): () => void
}

/**
 * Look up the Conversation event registry without declaring the service, so a
 * host that predates it still loads.
 * @param host - client context.
 * @returns the registry, or undefined when this host has none.
 */
function conversationEvents(host: ClientContext): ConversationEvents | undefined {
  const service = host.get('uiConversation') as { events?: Partial<ConversationEvents> } | undefined
  return typeof service?.events?.register === 'function' ? service.events as ConversationEvents : undefined
}

/**
 * Bind the card-action verb to the session a slot component was rendered in.
 * @param ctx - client root context, which owns the conversation lookup.
 * @param props - the slot component's props, carrying `sessionId`.
 * @returns the stable action sink.
 */
function useActionHandler(ctx: ClientContext, props: unknown): ActionHandler {
  const sessionId = sessionIdOf(props)
  return useCallback(
    (action: FrameAction, title: string) =>
      sendCardAction(ctx, sessionId, formatActionSubmission(action, title)),
    // The props object is new every render; the id is what the callback closes over.
    [ctx, sessionId],
  )
}

/**
 * Register the keyed toolview and the turn tail. Waiting on each hole's
 * declaration mirrors the official registrants: entry application order is
 * loader-driven, and a direct register racing the declaration fails boot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // This package's own Host-for-Client contribution has to be mounted here;
  // `dsh-api-remotes` only mounts the core contributions it knows about. The
  // resolver mounts lazily and retries, because the Remotes assembly may be
  // provided by another plugin that is not up during this call.
  const resolveRemote = createRemoteResolver(ctx)

  const OpenUiEntry = (props: Parameters<typeof OpenUiCard>[0]) => (
    <OpenUiCard
      {...props}
      onAction={useActionHandler(ctx, props)}
      callTool={useToolCallHandler(ctx, props, resolveRemote)}
    />
  )
  const TurnTailEntry = (props: Parameters<typeof OpenUiTurnCards>[0]) => (
    <OpenUiTurnCards
      {...props}
      onAction={useActionHandler(ctx, props)}
      callTool={useToolCallHandler(ctx, props, resolveRemote)}
    />
  )

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: OPENUI_TOOL_NAME },
    OpenUiEntry,
  ))

  // The Chat target declares its turn tail after its own settings and the
  // Conversation registry are up, so the registry is resolvable here.
  ctx.slots.inject('conversation.chat.turnTail', () => {
    const events = conversationEvents(ctx)
    if (events === undefined) return () => undefined
    const disposeDefinition = events.register(turnCardsDefinition as ConversationNodeDefinition)
    const disposeTail = ctx.slots.register(
      // After the host's own deliverables (0) and before lower-ranked entries.
      { name: 'conversation.chat.turnTail', id: 'dsh-openui-cards', order: 100 },
      TurnTailEntry,
    )
    return () => {
      disposeTail()
      disposeDefinition()
    }
  })
}
