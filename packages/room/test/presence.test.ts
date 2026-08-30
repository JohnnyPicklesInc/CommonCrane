// Who has gone quiet.
//
// The distinction these tests defend is between somebody who is behind and
// somebody who is gone. Getting it wrong is not a crash — it is entities being
// taken off players who are sitting right there, which reads as the game being
// broken rather than as a bug with a cause.

import { describe, it, expect } from 'vitest'
import { Presence } from '../src/index.ts'

const SILENCE = 4000

function room(players = 4): Presence {
  const p = new Presence({ players, silenceMs: SILENCE })
  for (let i = 0; i < players; i++) p.reset(i, 0)
  return p
}

describe('a player who stops sending', () => {
  it('is not called quiet before the silence is up', () => {
    const p = room()
    expect(p.look([0, 1], SILENCE - 1).quiet).toEqual([])
  })

  it('is called quiet once, not on every look', () => {
    const p = room()
    expect(p.look([0, 1], SILENCE + 1).quiet).toEqual([0, 1])
    // Still silent, but no longer news. A room that re-decided every look
    // would append a decision a second for the rest of the game.
    expect(p.look([0, 1], SILENCE + 2).quiet).toEqual([])
  })

  it('is heard again the moment they speak', () => {
    const p = room()
    p.look([0, 1], SILENCE + 1)
    expect(p.isQuiet(1)).toBe(true)
    p.hear(1, SILENCE + 2)
    const change = p.look([0, 1], SILENCE + 3)
    expect(change.back).toEqual([1])
    expect(p.isQuiet(1)).toBe(false)
  })
})

describe('a player who is merely a long way behind', () => {
  it('is never called quiet, however far back they are', () => {
    // The rule that cost the most to learn. Being behind is what a prediction
    // window and catching-up are for; a player who is still sending is here.
    // Judged by distance, somebody who had just been handed an entity was
    // relieved of it a second later every time, because a newcomer sits at the
    // far end of that window until their first inputs have made the trip.
    const p = room()
    let now = 0
    for (let i = 0; i < 50; i++) {
      now += 1000
      p.hear(1, now) // still talking, just late
      expect(p.look([0, 1], now).quiet).not.toContain(1)
    }
  })
})

describe('a place nobody holds', () => {
  it('cannot go quiet, because there is nobody to miss', () => {
    const p = room()
    // Player 2 is an empty seat and is simply not offered to `look`.
    expect(p.look([0, 1], SILENCE + 1).quiet).toEqual([0, 1])
    expect(p.isQuiet(2)).toBe(false)
  })
})

describe('a room where everybody has gone quiet at once', () => {
  it('still reports it, because the clock does not depend on traffic', () => {
    // The blind spot of checking only when a message arrives: with nobody
    // sending, nothing fires. Presence is a function of a clock and a held
    // set, so a timer can drive it with no traffic at all.
    const p = room()
    const change = p.look([0, 1, 2, 3], SILENCE + 1)
    expect(change.quiet).toEqual([0, 1, 2, 3])
  })
})
