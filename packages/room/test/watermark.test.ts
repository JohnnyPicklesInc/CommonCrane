// The line behind which nothing can change.
//
// Every failure below is silent in the game: no error, no wrong number on
// screen, just fingerprints quietly not being taken — so the desync check stops
// existing and nothing says so. That is why they are tested rather than
// commented.

import { describe, it, expect } from 'vitest'
import { Watermark } from '../src/index.ts'

/** A store of who has really sent what, as the caller would hold it. */
function store(): {
  put: (p: number, at: number) => void
  holds: (p: number, at: number) => boolean
} {
  const held = new Set<string>()
  return {
    put: (p, at) => void held.add(`${p}:${at}`),
    holds: (p, at) => held.has(`${p}:${at}`),
  }
}

describe('the line', () => {
  it('is the oldest point anybody is still missing', () => {
    const w = new Watermark({ players: 2 })
    const s = store()
    for (let t = 0; t <= 9; t++) s.put(0, t)
    for (let t = 0; t <= 4; t++) s.put(1, t)
    expect(w.line(s.holds)).toBe(4)
  })

  it('stops at a hole rather than jumping past it', () => {
    // A lost run leaves a gap. The newest thing seen is past it — trust that
    // and the points inside are called settled when they were simulated from a
    // guess nothing ever corrected, and both ends publish fingerprints for
    // states that could never agree.
    const w = new Watermark({ players: 1 })
    const s = store()
    for (const t of [0, 1, 2, 5, 6, 7]) s.put(0, t)
    expect(w.line(s.holds)).toBe(2)
    s.put(0, 3)
    expect(w.line(s.holds)).toBe(3)
    s.put(0, 4)
    expect(w.line(s.holds)).toBe(7)
  })
})

describe('a player whose input is no longer read', () => {
  it('stops holding the line back', () => {
    // The bug, and it is silent: one player goes quiet, the line pins where
    // they stopped, no fingerprint is ever taken again, and the desync check
    // switches itself off for the rest of the game.
    const w = new Watermark({ players: 2 })
    const s = store()
    for (let t = 0; t <= 99; t++) s.put(0, t)
    for (let t = 0; t <= 9; t++) s.put(1, t)
    expect(w.line(s.holds)).toBe(9)
    w.released(1, 10)
    expect(w.line(s.holds)).toBe(99)
  })

  it('still holds it for the points before they were released', () => {
    // The reason it is a point and not a flag. Their input counted right up to
    // the moment it stopped counting, and a fingerprint taken past a gap before
    // that is one a late packet can still change.
    const w = new Watermark({ players: 2 })
    const s = store()
    for (let t = 0; t <= 99; t++) s.put(0, t)
    for (const t of [0, 1, 2, 4, 5]) s.put(1, t) // missing 3
    w.released(1, 20)
    expect(w.line(s.holds)).toBe(2)
    s.put(1, 3)
    expect(w.line(s.holds)).toBe(5)
  })
})

describe('a place nobody was in at the start', () => {
  it('never holds the line back, without the caller remembering', () => {
    // The second half of the same bug. A place released mid-game and a place
    // that opened empty are the same thing, and a caller told to handle both
    // handles one — so the opening case is taken here instead.
    const w = new Watermark({ players: 4, absent: [2, 3] })
    const s = store()
    for (let t = 0; t <= 9; t++) {
      s.put(0, t)
      s.put(1, t)
    }
    expect(w.line(s.holds)).toBe(9)
  })
})

describe('a place given back', () => {
  it('does not have to answer for points before it was theirs', () => {
    const w = new Watermark({ players: 2, absent: [1] })
    const s = store()
    for (let t = 0; t <= 49; t++) s.put(0, t)
    w.reclaimed(1, 40)
    // They owe nothing before 40, so the line is not dragged back to -1.
    expect(w.line(s.holds)).toBe(39)
    for (let t = 40; t <= 45; t++) s.put(1, t)
    expect(w.line(s.holds)).toBe(45)
  })
})
