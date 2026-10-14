/**
 * The turn-tail collector's pure logic: which cards one turn ends up showing,
 * and which of them were settled before the turn's closing answer.
 */

import { describe, expect, it } from 'vitest'
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { cardsBefore, foldCard, TURN_CARDS_KEY, type TurnCard } from '../src/client/turn-cards.ts'
import type { OpenUiMeta } from '../src/meta.ts'

/** A descriptor with the fields the collector reads. */
function meta(path: string, title = 'Card'): OpenUiMeta {
  return {
    kind: 'openui',
    render: 'openui-lang',
    source: 'root = Card([])\n',
    title,
    mode: 'inline',
    path,
    libraryId: 'test',
    readTools: [],
    writeTools: [],
  }
}

/** A collected card. */
function card(callId: string, seq: number, path: string): TurnCard {
  return { callId, seq, meta: meta(path) }
}

/** A Turn location exposing only the data store the selector reads. */
function turnWith(cards: readonly TurnCard[]): TurnLocation {
  return {
    data: { get: (key: string) => (key === TURN_CARDS_KEY ? { cards } : undefined) },
  } as unknown as TurnLocation
}

describe('foldCard', () => {
  it('appends a card the turn has not seen', () => {
    const folded = foldCard([card('a', 1, '/p/a')], card('b', 2, '/p/b'))
    expect(folded.map(c => c.callId)).toEqual(['a', 'b'])
  })

  it('keeps the first entry when the same call is reported twice', () => {
    const first = card('a', 1, '/p/a')
    const folded = foldCard([first], { ...first, seq: 9 })
    expect(folded).toEqual([first])
  })

  it('replaces a card in place when an update lands on its path', () => {
    const folded = foldCard([card('a', 1, '/p/a'), card('b', 2, '/p/b')], card('c', 3, '/p/a'))
    expect(folded.map(c => c.callId)).toEqual(['c', 'b'])
    expect(folded).toHaveLength(2)
  })

  it('appends path-less cards rather than collapsing them together', () => {
    const folded = foldCard([card('a', 1, '')], card('b', 2, ''))
    expect(folded.map(c => c.callId)).toEqual(['a', 'b'])
  })

  it('returns the same list identity when nothing changed', () => {
    const cards = [card('a', 1, '/p/a')]
    expect(foldCard(cards, card('a', 5, '/p/a'))).toBe(cards)
  })
})

describe('cardsBefore', () => {
  it('keeps only the cards settled before the closing answer', () => {
    const turn = turnWith([card('a', 1, '/p/a'), card('b', 7, '/p/b')])
    expect(cardsBefore(turn, 5).map(c => c.callId)).toEqual(['a'])
  })

  it('returns every card when the answer closes the turn last', () => {
    const turn = turnWith([card('a', 1, '/p/a'), card('b', 7, '/p/b')])
    expect(cardsBefore(turn, 99)).toHaveLength(2)
  })

  it('is empty for a turn with no cards or no data store', () => {
    expect(cardsBefore(turnWith([]), 5)).toEqual([])
    expect(cardsBefore(undefined, 5)).toEqual([])
    expect(cardsBefore({} as TurnLocation, 5)).toEqual([])
  })
})
