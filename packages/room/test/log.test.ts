// The log a latecomer is handed.
//
// The shape of it matters more than it looks: the two bugs below both produced
// a newcomer who was plausibly in the game and hashing differently from
// everybody else, which is the worst failure this layer can have — it looks
// fine on screen and is wrong everywhere it counts.

import { describe, it, expect } from 'vitest'
import { ContributionLog } from '../src/index.ts'

describe('what a latecomer is sent', () => {
  it('has a row for every place, not only the ones that started', () => {
    // Somebody who joined after the drop has a row here too. Leaving it out is
    // how the third person to walk in ends up in a different game: they replay
    // it with the second person's entity never having moved.
    const log = new ContributionLog<number>({ players: 4 })
    log.record(0, 0, [1, 1, 1])
    log.record(2, 1, [7, 7]) // arrived late, still has a row
    const r = log.rectangle(0)
    expect(r).toHaveLength(4)
    expect(r[2]).toEqual([0, 7, 7])
    expect(r[1]).toEqual([0, 0, 0]) // never spoke, still present
  })

  it('is a rectangle with no holes', () => {
    // A point a player never spoke for is one they repeated themselves on,
    // which is what the client does with a gap anyway.
    const log = new ContributionLog<number>({ players: 2 })
    log.record(0, 0, [5])
    log.record(0, 3, [9]) // a hole at 1 and 2
    const r = log.rectangle(0)
    expect(r[0]).toEqual([5, 5, 5, 9])
  })

  it('runs to the newest thing anybody said', () => {
    const log = new ContributionLog<number>({ players: 3 })
    log.record(0, 0, [1])
    log.record(1, 0, [2, 2, 2, 2])
    expect(log.head).toBe(3)
    expect(log.rectangle(0)[0]).toHaveLength(4)
  })
})

describe('the redundancy every message carries', () => {
  it('costs nothing to record twice', () => {
    // Every message repeats the last couple of dozen contributions so a lost
    // packet heals itself, which makes re-recording the ordinary case.
    const log = new ContributionLog<number>({ players: 2 })
    log.record(0, 0, [1, 2, 3])
    log.record(0, 1, [2, 3, 4])
    log.record(0, 0, [1, 2, 3, 4])
    expect(log.rectangle(0)[0]).toEqual([1, 2, 3, 4])
    expect(log.head).toBe(3)
  })
})

describe('a malformed claim', () => {
  it('is refused rather than repaired', () => {
    const log = new ContributionLog<number>({ players: 2 })
    expect(log.record(5, 0, [1])).toBe(false)
    expect(log.record(-1, 0, [1])).toBe(false)
    expect(log.record(0, -1, [1])).toBe(false)
    expect(log.record(0, 0, [1])).toBe(true)
  })
})

describe('compaction', () => {
  it('moves the origin forward and keeps what is still asked for', () => {
    // What makes an unbounded game possible: once a state at `to` exists,
    // everything before it is re-derivable and costs only memory.
    const log = new ContributionLog<number>({ players: 2 })
    log.record(0, 0, [1, 2, 3, 4, 5])
    log.record(1, 0, [9, 9, 9, 9, 9])
    log.compact(3)
    expect(log.origin).toBe(3)
    expect(log.head).toBe(4)
    expect(log.rectangle(0)[0]).toEqual([4, 5])
  })

  it('keeps recording correctly against the new origin', () => {
    const log = new ContributionLog<number>({ players: 1 })
    log.record(0, 0, [1, 2, 3, 4])
    log.compact(2)
    log.record(0, 4, [5])
    expect(log.rectangle(0)[0]).toEqual([3, 4, 5])
  })

it('starts from the beginning again after a compacted match is cleared', () => {
  // Not from wherever the last game was cut back to. The failure is silent:
  // the next match reports a log starting at a point nobody has played, with
  // no world to explain it, and every row is read off by that much.
  const log = new ContributionLog<number>({ players: 2 })
  for (let t = 0; t < 50; t++) log.record(0, t, [t])
  log.compact(30)
  expect(log.origin).toBe(30)
  log.clear()
  expect(log.origin).toBe(0)
  expect(log.lastFrom(0)).toBe(-1)
})
})
