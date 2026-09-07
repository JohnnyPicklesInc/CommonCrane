// Putting strangers into the same room.

import { describe, it, expect } from 'vitest'
import { gather, filling, startsIn, type Held } from '../src/index.ts'

const NOW = 1_000_000
const STALE = 240_000
let minted = 0
const mint = (): string => `R${++minted}`
const opts = (over: Partial<Parameters<typeof gather>[1]> = {}) => ({
  now: NOW,
  staleMs: STALE,
  mint,
  ...over,
})

describe('where everybody is sent', () => {
  it('is the room already being handed out', () => {
    const held: Held = { code: 'AAAA', opened: NOW - 1000 }
    const got = gather(held, opts())
    expect(got.code).toBe('AAAA')
    expect(got.fresh).toBe(false)
  })

  it('is the same room for everybody asking at once', () => {
    // The whole reason this exists. Three people arriving in the same
    // millisecond get one room between them — which is what a list of open
    // rooms cannot promise, because all three read it before any of them
    // wrote to it.
    const held: Held = { code: 'AAAA', opened: NOW - 1000 }
    const all = [gather(held, opts()), gather(held, opts()), gather(held, opts())]
    expect(new Set(all.map((g) => g.code)).size).toBe(1)
  })

  it('is a new room when there is none, and says so', () => {
    const got = gather(null, opts())
    expect(got.fresh).toBe(true)
    expect(got.opened).toBe(NOW)
  })

  it('is a new room once the held one is too old to trust', () => {
    // Nothing retracts an entry for a room that was evicted or crashed, so
    // being handed out for ever is the one failure a held code can have on its
    // own.
    const stale: Held = { code: 'AAAA', opened: NOW - STALE - 1 }
    expect(gather(stale, opts()).fresh).toBe(true)
  })

  it('does not trust a held entry with no time on it', () => {
    // A comparison against `undefined` is false, which is exactly the wrong way
    // round: it makes an entry that cannot be shown to be fresh count as fresh.
    const nonsense = { code: 'AAAA' } as unknown as Held
    expect(gather(nonsense, opts()).fresh).toBe(true)
  })
})

describe('when a room that is filling up starts', () => {
  const base = { least: 2, most: 6, waitMs: 45_000, fullMs: 6_000, now: NOW }

  it('is never, while there are too few to bother', () => {
    expect(filling({ ...base, here: 1, startsAt: 0 })).toBe(0)
  })

  it('stops counting if somebody leaves and takes it below', () => {
    // Left running, the last person standing is dropped into a game on their
    // own — which is the single-player game they did not press.
    expect(filling({ ...base, here: 1, startsAt: NOW + 10_000 })).toBe(0)
  })

  it('starts counting as soon as it could go', () => {
    expect(filling({ ...base, here: 2, startsAt: 0 })).toBe(NOW + 45_000)
  })

  it('leaves a clock that is already running alone', () => {
    // Restarted on every arrival, a room where people keep trickling in never
    // starts at all.
    const running = NOW + 9_000
    expect(filling({ ...base, here: 3, startsAt: running })).toBe(running)
  })

  it('brings it forward when the room fills up', () => {
    const running = NOW + 40_000
    expect(filling({ ...base, here: 6, startsAt: running })).toBe(NOW + 6_000)
  })

  it('never pushes it back', () => {
    // A clock reading four seconds must not become six because the last chair
    // was taken. Whoever is watching it counted four.
    const imminent = NOW + 4_000
    expect(filling({ ...base, here: 6, startsAt: imminent })).toBe(imminent)
  })

  it('counts a full room down even if it filled before anyone was waiting', () => {
    expect(filling({ ...base, here: 6, startsAt: 0 })).toBe(NOW + 6_000)
  })
})

describe('what the countdown says', () => {
  it('is nothing at all while it is not counting', () => {
    expect(startsIn(0, NOW)).toBe(-1)
  })

  it('is seconds, rounded', () => {
    expect(startsIn(NOW + 4_400, NOW)).toBe(4)
    expect(startsIn(NOW + 4_600, NOW)).toBe(5)
  })

  it('never goes below zero once the moment has passed', () => {
    // The room starts on its own clock and a screen a beat behind it would
    // otherwise count into the negatives while waiting to be told.
    expect(startsIn(NOW - 3_000, NOW)).toBe(0)
  })
})
