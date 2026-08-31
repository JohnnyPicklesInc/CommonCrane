import { describe, it, expect } from 'vitest'
import { Match, rollbackClock } from '../src/index.ts'

// What "free" means, which is not what it looked like.
//
// Two questions that read the same and are not: is the computer driving this
// place, and is anybody answerable for it. A player who has gone quiet is both
// — the computer has their place *and* it is still theirs, because they are
// lagging rather than gone. Answering the first when you meant the second hands
// a newcomer somebody else's place while they are sitting right there.

describe('a place somebody holds but the computer is driving', () => {
  it('is not free for a newcomer to take', () => {
    // A player who has gone quiet still holds their place — they are lagging,
    // not gone. Handing it to somebody who has just walked in takes it off
    // them while they are sitting there.
    const m = new Match({
      players: 6,
      clock: rollbackClock({ window: 14, slack: 4 }),
      silenceMs: 4000,
    })
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    m.contribute(0, 0, [1], 0)
    m.observe([0, 1], 5000) // player 1 goes quiet; the computer takes their place
    expect(m.isAutomatic(1)).toBe(true)
    expect(m.vacant([0, 1])).toBe(2) // the first place nobody is answerable for
  })

  it('becomes free the moment they actually go', () => {
    const m = new Match({
      players: 6,
      clock: rollbackClock({ window: 14, slack: 4 }),
      silenceMs: 4000,
    })
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    m.contribute(0, 0, [1], 0)
    m.leave(1, 0)
    expect(m.vacant([0])).toBe(1)
  })

  it('can be asked for a place that suits, and skips the rest', () => {
    // A game whose places carry a side — evens one way, odds the other — asks
    // for a free one on the side that wants filling.
    const m = new Match({
      players: 6,
      clock: rollbackClock({ window: 14, slack: 4 }),
      silenceMs: 4000,
    })
    m.begin({ roster: 6, playing: [0, 1, 2], now: 0 })
    m.contribute(0, 0, [1], 0)
    expect(m.vacant([0, 1, 2], (p) => p % 2 === 1)).toBe(3)
    expect(m.vacant([0, 1, 2], (p) => p % 2 === 0)).toBe(4)
  })
})
