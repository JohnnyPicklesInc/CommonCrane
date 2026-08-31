// The room before the game starts.

import { describe, it, expect } from 'vitest'
import { Lobby } from '../src/index.ts'

type Setup = { arena: number; rounds: number }
type Side = 0 | 1

const check = (raw: unknown): Setup | null => {
  const s = raw as Partial<Setup>
  if (!Number.isInteger(s.arena) || !Number.isInteger(s.rounds)) return null
  if (s.rounds! < 1 || s.rounds! > 9) return null
  return { arena: s.arena!, rounds: s.rounds! }
}
const side = (raw: unknown): Side | null => (raw === 0 || raw === 1 ? raw : null)

function lobby(): Lobby<Setup, Side> {
  return new Lobby<Setup, Side>({
    settings: { arena: 0, rounds: 3 },
    checkSettings: check,
    checkSeat: side,
  })
}

describe('what the host may change', () => {
  it('is the settings, before the drop', () => {
    const l = lobby()
    expect(l.propose(true, false, { arena: 2, rounds: 5 })).toEqual({ arena: 2, rounds: 5 })
    expect(l.settings).toEqual({ arena: 2, rounds: 5 })
  })

  it('is nobody else', () => {
    const l = lobby()
    expect(l.propose(false, false, { arena: 2, rounds: 5 })).toBeNull()
    expect(l.settings).toEqual({ arena: 0, rounds: 3 })
  })

  it('is not after it has started', () => {
    // The settings are folded into the state every client builds, so changing
    // them mid-game is not a change of mind — it is two people playing
    // different games.
    const l = lobby()
    expect(l.propose(true, true, { arena: 2, rounds: 5 })).toBeNull()
    expect(l.settings).toEqual({ arena: 0, rounds: 3 })
  })
})

describe('a setting the game will not accept', () => {
  it('is refused whole, never repaired', () => {
    // A repaired setting is worse than a refused one: whoever asked watches
    // their choice silently become somebody else's, and the value the game
    // ends up with is one its simulation was never tested against.
    const l = lobby()
    expect(l.propose(true, false, { arena: 1, rounds: 99 })).toBeNull()
    expect(l.settings).toEqual({ arena: 0, rounds: 3 })
  })
})

describe('a seat choice', () => {
  it('is checked by the game and handed back', () => {
    const l = lobby()
    expect(l.choose(1)).toBe(1)
    expect(l.choose(7)).toBeNull()
  })
})

describe('the public list', () => {
  it('is the host’s to offer', () => {
    const l = lobby()
    expect(l.announce(true, true)).toBe(true)
    expect(l.announced).toBe(true)
  })

  it('is nobody else’s', () => {
    const l = lobby()
    l.announce(true, false)
    expect(l.announce(false, true)).toBe(false)
    expect(l.announced).toBe(false)
  })
})

describe('what survives the room forgetting itself', () => {
  it('is what everybody agreed to play, and the terms it opened on', () => {
    const l = lobby()
    l.open({ build: 'v3', code: 'ABCD', announced: true, now: 42 })
    l.propose(true, false, { arena: 2, rounds: 5 })
    const kept = l.snapshot()

    const woken = lobby()
    woken.restore(kept)
    expect(woken.settings).toEqual({ arena: 2, rounds: 5 })
    expect(woken.build).toBe('v3')
    expect(woken.code).toBe('ABCD')
    expect(woken.announced).toBe(true)
    expect(woken.since).toBe(42)
  })
})

describe('the view', () => {
  it('is a roster, everybody’s own choice, and the one the host set', () => {
    const l = lobby()
    l.propose(true, false, { arena: 2, rounds: 5 })
    const seen = l.view(
      [{ chairs: [0, 1], name: 'Ann', seats: [0, 1] }, { chairs: [3], name: 'Bo', seats: [1] }],
      4,
      (s, i) => (i === 0 ? s.name : `${s.name} ${i + 1}`),
      0,
    )
    expect(seen.players).toEqual(['Ann', 'Ann 2', null, 'Bo'])
    expect(seen.seats).toEqual([0, 1, null, 1])
    expect(seen.settings).toEqual({ arena: 2, rounds: 5 })
    expect(seen.host).toBe(0)
  })
})
