/**
 * A turn's settled OpenUI cards, collected so they can be shown again under the
 * turn's closing answer.
 *
 * The Web chat folds a finished turn's process — every tool row, and the card
 * inside it — behind the turn's duration summary. An OpenUI card is the turn's
 * *output*, not its process, so it is re-shown on the turn tail, the seat the
 * host's own deliverables and plans use for the same reason. The toolview card
 * stays inside the fold as the call's own record.
 *
 * This is a state-only Conversation Definition: it publishes the turn's cards as
 * Turn location data and renders no Node itself. Nothing here reads the session
 * log directly or imports host runtime code.
 *
 * ## The one thing this deliberately does not do
 *
 * `dsh-visualize` hides its tail cards again when the reader's work-details mode
 * is `verbose`, because the host is then not folding and the card is already on
 * screen. That check is skipped here on purpose: the preference is read through
 * a host settings service whose 0.2 shape could not be verified from the packages
 * available to this build, and guessing wrong would *suppress* the card — the
 * exact opposite of why the tail exists. Showing it twice in `verbose` mode is
 * the softer failure.
 *
 * @module @blaueck/dsh-openui/client/turn-cards
 */

import type {
  ConversationLocationData,
  ConversationNodeDefinition,
  TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  OPENUI_TOOL_NAME,
  openUiMetaFrom,
  openUiMetaFromArgs,
  openUiPathFromText,
  type OpenUiMeta,
} from '../meta.ts'

/** Definition kind and Turn data key; namespaced by package to stay unique. */
export const TURN_CARDS_KEY = 'dsh-openui'

/** One settled card, keyed by the call that produced it. */
export interface TurnCard {
  readonly callId: string
  readonly seq: number
  readonly meta: OpenUiMeta
}

/** Per-turn value published on the Turn Location. */
export interface OpenUiTurnData {
  readonly cards: readonly TurnCard[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Settled OpenUI cards of this Turn, one per card path. */
    'dsh-openui': OpenUiTurnData
  }
}

/** The Definition's own State: the published value plus its turn number. */
interface TurnCardsState extends OpenUiTurnData {
  readonly turn: number
}

/** One successful root result, already narrowed. */
interface ResultCard {
  readonly turn: number
  readonly callId: string
  readonly meta: OpenUiMeta
}

/** The slice of a `tool/ptc-dispatch` event this Definition reads. */
interface PtcDispatchData {
  readonly rootCallId?: unknown
  readonly subCallId?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
  readonly content?: unknown
  readonly isError?: unknown
}

/**
 * Accept a successful root `openui` result. The persisted meta names its own
 * kind, so no call-to-name bookkeeping is needed.
 *
 * Every field is read through a guard rather than assumed: this runs inside the
 * conversation engine's event matching, where a throw would take out the
 * transcript rather than just this card.
 * @param data - `tool/result` payload.
 * @returns the turn, call id and descriptor, or undefined when unrelated or failed.
 */
function readResult(data: unknown): ResultCard | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  const message = record['message']
  if (typeof message !== 'object' || message === null) return undefined
  const fields = message as Record<string, unknown>
  if (fields['isError'] === true) return undefined
  const source = fields['source']
  const callId = typeof source === 'object' && source !== null
    ? (source as Record<string, unknown>)['callId']
    : undefined
  const turn = record['turn']
  if (typeof callId !== 'string' || typeof turn !== 'number') return undefined
  const meta = openUiMetaFrom(record['meta'])
  return meta === undefined ? undefined : { turn, callId, meta }
}

/**
 * Rebuild one nested-dispatch card.
 *
 * A PTC sub-call never projects persisted `tool/result` meta — the host projects
 * meta for top-level calls only — but it does log its own `arguments`, which
 * hold the same program the toolview renders from. A nested `update` carries
 * only a patch, which needs the card it addresses; that base is not reachable
 * from here, so a nested update simply does not reappear on the tail. A
 * *top-level* update does, because its persisted meta holds the merged program.
 * @param data - the `tool/ptc-dispatch` payload.
 * @param seq - the dispatch event's sequence number.
 * @returns the card, or undefined when this dispatch is not a successful create.
 */
function dispatchCard(data: PtcDispatchData, seq: number): TurnCard | undefined {
  if (data.name !== OPENUI_TOOL_NAME || data.isError === true) return undefined
  if (typeof data.subCallId !== 'string') return undefined
  const raw = data.arguments
  const args = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
  const meta = openUiMetaFromArgs(args)
  if (meta === undefined) return undefined
  // A nested create's arguments carry the program but not the name the tool
  // chose; the result text does, and a later `update` addresses the card by
  // exactly that name.
  const path = meta.path !== '' ? meta.path : openUiPathFromText(data.content)
  return { callId: data.subCallId, seq, meta: path === undefined ? meta : { ...meta, path } }
}

/** One event already reduced to a card this Turn should show. */
function cardFrom(event: { readonly type: string; readonly data: unknown; readonly seq: number }): TurnCard | undefined {
  if (event.type !== 'tool/result') return undefined
  const result = readResult(event.data)
  return result === undefined ? undefined : { callId: result.callId, seq: event.seq, meta: result.meta }
}

/**
 * Turn of the most recent `turn/start`, and the turn each outer `tool/call`
 * began in. A `tool/ptc-dispatch` carries no turn of its own, so a nested card is
 * attributed to the turn its root call started in; the running turn is the
 * fallback when a replay window opens after the root call. Module scope rather
 * than Definition state because `match` receives no Context.
 */
let currentTurn = 0
const callTurns = new Map<string, number>()

/**
 * Fold one card into a state, preserving identity when nothing changed.
 * @param state - the turn's state so far.
 * @param card - the incoming card.
 * @returns the next state, or the same one when the card list is unchanged.
 */
function foldInto(state: TurnCardsState, card: TurnCard): TurnCardsState {
  const cards = foldCard(state.cards, card)
  return cards === state.cards ? state : { ...state, cards }
}

/**
 * Fold one result into the turn's cards. A repeated call id (a later surface
 * replacement of the same result) keeps the first; a later card at an existing
 * path (an `update`) replaces that card in place, so a corrected card is shown
 * once, in its original position.
 * @param cards - cards so far.
 * @param card - the incoming card.
 * @returns the next card list, or the same list when unchanged.
 */
export function foldCard(cards: readonly TurnCard[], card: TurnCard): readonly TurnCard[] {
  if (cards.some(existing => existing.callId === card.callId)) return cards
  if (card.meta.path === '') return [...cards, card]
  const index = cards.findIndex(existing => existing.meta.path === card.meta.path)
  if (index === -1) return [...cards, card]
  return cards.map((existing, at) => at === index ? card : existing)
}

/**
 * Extract this Definition's matches.
 *
 * Wrapped in a guard because it runs inside the conversation engine's event
 * matching: an unexpected event shape must decline the match, not take out the
 * transcript around it.
 */
const matchEvent: ConversationNodeDefinition<TurnCardsState>['match'] = (event) => {
  try {
    if (event.type === 'turn/start') {
      const turn = event.data.turn
      if (typeof turn !== 'number') return null
      currentTurn = turn
      return { id: String(turn), role: 'start' }
    }
    if (event.type === 'tool/call') {
      // Remember the turn this outer call began in: a nested dispatch of it
      // carries none, and the turn-tail collector keys every card by turn.
      const call = event.data as { readonly callId?: unknown; readonly turn?: unknown }
      if (typeof call.callId === 'string' && typeof call.turn === 'number') callTurns.set(call.callId, call.turn)
      return null
    }
    if (event.type === 'tool/result') {
      const result = readResult(event.data)
      if (result === undefined) return null
      // A nested create whose root call already settled still has to be
      // attributed, so its remembered turn is kept until the turn ends.
      return { id: String(result.turn), role: 'update' }
    }
    if (event.type !== 'tool/ptc-dispatch') return null
    const data = event.data as PtcDispatchData
    if (dispatchCard(data, event.seq) === undefined) return null
    const rootId = typeof data.rootCallId === 'string' ? data.rootCallId : undefined
    const turn = (rootId === undefined ? undefined : callTurns.get(rootId)) ?? currentTurn
    return turn > 0 ? { id: String(turn), role: 'update' } : null
  } catch {
    return null
  }
}

/** Turn-local OpenUI accumulator; it publishes Turn data and no view Node. */
export const turnCardsDefinition: ConversationNodeDefinition<TurnCardsState> = {
  kind: TURN_CARDS_KEY,
  match: matchEvent,
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('dsh-openui: turn cards start requires turn/start')
    // A replay that begins at the session's first turn starts the cross-turn
    // bookkeeping over, so one session's calls cannot leak into another's.
    if (match.event.data.turn === 1) callTurns.clear()
    return { turn: match.event.data.turn, cards: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/ptc-dispatch') {
      const card = dispatchCard(match.event.data as PtcDispatchData, match.event.seq)
      return card === undefined ? context.state : foldInto(context.state, card)
    }
    const card = cardFrom(match.event)
    return card === undefined ? context.state : foldInto(context.state, card)
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    const { turn, cards } = context.state
    if (previous?.kind === 'turn' && previous.turn === turn && previous.key === TURN_CARDS_KEY
      && previous.value.cards === cards) return previous
    return { kind: 'turn', turn, key: TURN_CARDS_KEY, value: { cards } } satisfies ConversationLocationData
  },
}

/**
 * The cards settled before the turn's closing reply.
 * @param turn - the closing turn; an older host may omit its data store.
 * @param seq - the closing assistant message's sequence number.
 * @returns the cards to show, possibly empty.
 */
export function cardsBefore(turn: TurnLocation | undefined, seq: number): readonly TurnCard[] {
  // Optional-chained past the type: a host older than the Turn data store would
  // otherwise throw here rather than simply showing no cards.
  const cards = turn?.data?.get(TURN_CARDS_KEY)?.cards ?? []
  return cards.filter(card => card.seq < seq)
}
