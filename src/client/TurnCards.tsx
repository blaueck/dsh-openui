/**
 * A turn's settled OpenUI cards, shown again under its closing answer.
 *
 * A finished turn folds its process — every tool row, and the card inside it —
 * behind the turn's duration summary, which leaves the card hard to find. The
 * turn tail is the seat the host's own deliverables and plans use to put a
 * turn's *output* back in view, so an OpenUI card belongs here.
 *
 * The cards come from the state-only Definition in `turn-cards.ts`; this module
 * only renders them, reusing the same frame the toolview mounts. Each card gets a
 * distinct frame token (`turn-tail:<callId>`): the toolview's frame for the same
 * call may be mounted at the same time inside an opened fold, and two frames
 * answering to one token would fight over the card's height and actions.
 *
 * @module @blaueck/dsh-openui/client/TurnCards
 */

import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `conversation.chat.turnTail` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { OpenUiFrame, type ActionHandler, type ToolCallHandler } from './OpenUiCard.tsx'
import { cardsBefore } from './turn-cards.ts'
import type { CustomComponent } from '../registry.ts'

/**
 * `minmax(0, 1fr)` rather than the implicit `auto` track a bare `display: grid`
 * creates. An `auto` track's minimum is the item's min-content width, so a card
 * with a long title or a wide frame widens the track past the column and the
 * whole transcript scrolls sideways. The zero minimum lets the track shrink and
 * makes the card fit instead.
 */
const listStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: 12,
  margin: '8px 0 4px',
}

/**
 * Turn-tail entry: the cards this turn settled, in the order they were made.
 * Mounted on every completed turn, so it declines turns without cards itself.
 * @param props - turn owner props plus the sinks bound to the card's session.
 * @returns the turn's cards, or null when it produced none.
 */
export function OpenUiTurnCards({
  turn, seq, onAction, callTool, components,
}: PropsRuntime<'conversation.chat.turnTail'> & {
  onAction?: ActionHandler | undefined
  callTool?: ToolCallHandler | undefined
  components?: readonly CustomComponent[] | undefined
}) {
  const cards = cardsBefore(turn, seq)
  if (cards.length === 0) return null
  return (
    <div style={listStyle}>
      {cards.map(card => (
        <OpenUiFrame
          key={card.callId}
          meta={card.meta}
          callId={`turn-tail:${card.callId}`}
          onAction={onAction}
          callTool={callTool}
          components={components}
        />
      ))}
    </div>
  )
}
