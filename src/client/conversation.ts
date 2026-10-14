/**
 * The bridge from an OpenUI card action to the conversation.
 *
 * A card runs in an opaque-origin frame and cannot reach the session; the
 * browser half can. Sending rides the host's own scope-addressed services —
 * `sessions.scope(id)` mints (or borrows) the Agent-scoped context and
 * `conversation` is read through it — so the queued turn is routed exactly like
 * one typed into the composer, and a failure rejects with the host's own reason
 * instead of silently dropping the submission.
 *
 * Services are read through optional `get` so a host that ships neither degrades
 * to a visible error inside the card rather than failing to load.
 *
 * @module @blaueck/dsh-openui/client/conversation
 */

/** A session-scoped Cordis context; only `get` is needed. */
interface ScopedContext {
  get(name: string): unknown
}

/** The `sessions` service face this module needs. */
interface SessionsFace {
  /**
   * Borrow the Agent-scoped context for one retained session.
   * @param id - session id.
   * @returns the scoped context, or undefined without a retained generation.
   */
  scope(id: string): ScopedContext | undefined
}

/** The scope-addressed `conversation` service face this module needs. */
interface ConversationFace {
  /**
   * Send a prompt into the scoped session as a queued turn.
   * @param text - prompt text.
   */
  send(text: string): Promise<void>
}

/** The host surface, read through optional `get`. */
export interface ConversationHost {
  get(name: string): unknown
}

/** One action event as the frame narrowed it. */
export interface FrameAction {
  type: string
  params: Record<string, unknown>
  humanFriendlyMessage: string
  formState: Record<string, unknown> | null
  formName: string | null
}

/**
 * Queue one card action as a user turn in the card's session.
 * @param host - client root context, read through optional `get`.
 * @param sessionId - the session the card was rendered in, from the per-session standard props.
 * @param text - the formatted submission.
 * @returns completion once the host admits the turn.
 * @throws Error naming the missing link; the card shows it beside the control.
 */
export async function sendCardAction(host: ConversationHost, sessionId: unknown, text: string): Promise<void> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('this card is not bound to a session')
  }
  const sessions = host.get('sessions') as SessionsFace | undefined
  const scoped = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined
  const conversation = scoped?.get('conversation') as ConversationFace | undefined
  if (typeof conversation?.send !== 'function') {
    throw new Error('this session cannot receive a card action')
  }
  await conversation.send(text)
}

/**
 * Format one action as the user turn the model will read.
 *
 * The card title names which surface acted, the human-friendly message is what
 * the program author wrote into `@ToAssistant(...)`, and the form values are
 * listed so the model does not have to ask for them again. Values are rendered
 * as compact JSON, which keeps nesting intact without inventing a schema.
 * @param action - the narrowed action event.
 * @param title - the card's title.
 * @returns the message text.
 */
export function formatActionSubmission(action: FrameAction, title: string): string {
  const lines: string[] = []
  const message = action.humanFriendlyMessage.trim()
  const form = action.formName === null || action.formName.length === 0 ? '' : ` · form "${action.formName}"`
  lines.push(`[OpenUI card "${title}"${form}] ${message.length > 0 ? message : `action ${action.type}`}`)
  const state = action.formState
  if (state !== null && Object.keys(state).length > 0) {
    for (const [name, value] of Object.entries(state)) {
      lines.push(`${name}: ${renderValue(value)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Render one submitted value for the transcript.
 * @param value - the field value.
 * @returns a compact single-line rendering.
 */
function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
