// The transitions.
//
// Every test here is a bug that shipped, and every one of them was an ordering
// mistake between calls that were individually correct. That is why they live
// behind single methods now: the tests below could not fail without the API
// offering a wrong order to choose.

import { describe, it, expect } from 'vitest'
import { Match, rollbackClock } from '../src/index.ts'

const WINDOW = 14
const SILENCE = 4000

function match(): Match {
  return new Match({
    players: 8,
    clock: rollbackClock({ window: WINDOW, slack: 4 }),
    silenceMs: SILENCE,
  })
}

describe('beginning a match', () => {
  it('does not call everybody quiet on the opening tick', () => {
    // The bug, and it is worth stating as a property rather than a sequence.
    // Started by hand, the presence clock was reset over the players who held a
    // place — before anybody had been dealt one. Every clock stayed at zero, so
    // the first look called all of them quiet and handed every place to the
    // computer immediately. Two ends then applied those at different points and
    // played different matches.
    // The clock has to be well past the silence, or the test passes with the
    // bug still in: at a wall clock of one second nobody is four seconds quiet
    // whether their clock was started or not.
    const START = SILENCE * 10
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: START })
    expect(m.observe(START)).toEqual([])
    expect(m.isAutomatic(0)).toBe(false)
    expect(m.isAutomatic(1)).toBe(false)
  })

  it('leaves the spare places to the computer from the start', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: SILENCE * 10 })
    expect(m.isAutomatic(2)).toBe(true)
    expect(m.isAutomatic(3)).toBe(true)
    // And they are what a latecomer is given.
    expect(m.vacant()).toBe(2)
  })

  it('never dates a latecomer’s place into the past', () => {
    // A spare place has never spoken, so its last word is -1: dated off that,
    // the first arrival was dealt a place from a point hundreds of ticks behind
    // the match. Their client rewinds for it, runs off the end of its history,
    // and abandons it in silence — the room certain they are playing while they
    // are still watching.
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: SILENCE * 10 })
    for (let t = 0; t < 233; t++) m.contribute(0, t, [1], SILENCE * 10)
    const h = m.seat(2, SILENCE * 10)
    expect(h.at).toBeGreaterThan(m.head)
  })
})

describe('a player who goes quiet', () => {
  it('is called quiet once, and only after the silence is up', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    expect(m.observe(SILENCE - 1)).toEqual([])
    const first = m.observe(SILENCE + 1)
    expect(first.map((h) => h.p)).toEqual([0, 1])
    expect(first.every((h) => h.on)).toBe(true)
    // Still silent, but no longer news: a room that re-decided every look would
    // append a handover a second for the rest of the match.
    expect(m.observe(SILENCE + 2)).toEqual([])
  })

  it('gets their place back the moment they speak', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    m.observe(SILENCE + 1)
    expect(m.isAutomatic(1)).toBe(true)
    const back = m.contribute(1, 0, [7], SILENCE + 2)
    expect(back?.map((h) => h.on)).toEqual([false])
    expect(m.isAutomatic(1)).toBe(false)
  })

  it('is never called quiet while they are merely a long way behind', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    let now = 0
    for (let t = 0; t < 40; t++) {
      now += 1000
      m.contribute(1, t, [1], now)
      expect(m.observe(now).some((h) => h.p === 1 && h.on)).toBe(false)
    }
  })
})

describe('a connection that goes', () => {
  it('changes hands at once rather than after the silence', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    const gone = m.leave(1, 100)
    expect(gone.map((h) => h.on)).toEqual([true])
    expect(m.isAutomatic(1)).toBe(true)
    // And is not announced twice when the clock comes round.
    expect(m.observe(SILENCE + 1).some((h) => h.p === 1)).toBe(false)
  })
})

describe('what a latecomer is handed', () => {
  it('is a row per place, with no holes, and every handover since', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    m.contribute(0, 0, [1, 2, 3], 0)
    m.contribute(1, 0, [9], 0)
    const seated = m.seat(2, 0)
    const c = m.catchup()
    expect(c.log).toHaveLength(4)
    expect(c.log.every((r) => r.length === c.at + 1)).toBe(true)
    // Filled forward: a point somebody never spoke for is one they repeated
    // themselves on, which is what a client does with a gap anyway.
    expect(c.log[1]).toEqual([9, 9, 9])
    // And the handover that seated them is in the record, not merely sent.
    expect(c.handovers).toContainEqual(seated)
  })
})

describe('recycling a room', () => {
  it('forgets the match completely', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    m.contribute(0, 0, [1, 2, 3], 0)
    m.end()
    expect(m.started).toBe(false)
    expect(m.head).toBe(-1)
    expect(m.vacant()).toBe(-1)
    expect(m.isAutomatic(2)).toBe(false)
    expect(m.catchup().handovers).toEqual([])
  })
})
