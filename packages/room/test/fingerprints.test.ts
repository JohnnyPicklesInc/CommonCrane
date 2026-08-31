// Noticing that two clients have stopped playing the same game.

import { describe, it, expect } from 'vitest'
import { Fingerprints } from '../src/index.ts'

const prints = (): Fingerprints => new Fingerprints({ keep: 4 })

describe('two clients that agree', () => {
  it('are not news', () => {
    const f = prints()
    expect(f.offer(60, 111)).toBe(false)
    expect(f.offer(60, 111)).toBe(false)
    expect(f.reported(60)).toBe(false)
  })
})

describe('two clients that disagree', () => {
  it('are news, once', () => {
    // A room that announced every disagreement would announce one per client
    // per checkpoint for the rest of the game, all of them the same news.
    const f = prints()
    expect(f.offer(60, 111)).toBe(false)
    expect(f.offer(60, 222)).toBe(true)
    expect(f.offer(60, 333)).toBe(false)
    expect(f.reported(60)).toBe(true)
  })

  it('are judged against the first fingerprint seen, not the last', () => {
    const f = prints()
    f.offer(60, 111)
    f.offer(60, 222) // announced
    // A third client agreeing with the first is still not a new disagreement.
    expect(f.offer(60, 111)).toBe(false)
  })
})

describe('what is remembered', () => {
  it('is only the last few points', () => {
    // Enough to catch a disagreement, not to keep a history: the first one is
    // the only one that means anything, because everything after it is
    // downstream of the same divergence.
    const f = prints()
    for (const at of [10, 20, 30, 40, 50]) f.offer(at, 1)
    // 10 has been dropped, so a second client's fingerprint for it is taken as
    // the first rather than compared against one.
    expect(f.offer(10, 999)).toBe(false)
    // The ones still held are compared properly.
    expect(f.offer(50, 999)).toBe(true)
  })

  it('is forgotten when the room plays again', () => {
    const f = prints()
    f.offer(60, 111)
    f.offer(60, 222)
    f.clear()
    expect(f.reported(60)).toBe(false)
    expect(f.offer(60, 999)).toBe(false)
  })
})

describe('a malformed point', () => {
  it('is ignored rather than remembered', () => {
    const f = prints()
    expect(f.offer(1.5, 111)).toBe(false)
    expect(f.offer(Number.NaN, 111)).toBe(false)
  })
})
