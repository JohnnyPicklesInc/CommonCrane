// Holding a world somebody else is simulating.
//
// The properties worth pinning are the two clocks: that your own player answers
// at once and is corrected without drifting, and that what is drawn lags the
// truth on purpose so there is always something to blend towards.

import { describe, it, expect } from 'vitest'
import { Authority } from '../src/authority.ts'
import { Follower } from '../src/follower.ts'
import type { Sim } from '../src/rollback.ts'

interface Toy {
  at: number
  pos: number[]
}

function toy(players: number): Sim<Toy> {
  return {
    create: () => ({ at: 0, pos: new Array<number>(players).fill(0) }),
    clone: (s) => ({ at: s.at, pos: [...s.pos] }),
    copy: (into, from) => {
      into.at = from.at
      for (let i = 0; i < from.pos.length; i++) into.pos[i] = from.pos[i]!
    },
    pointOf: (s) => s.at,
    step: (s, inputs) => {
      for (let p = 0; p < inputs.length; p++) s.pos[p] = (s.pos[p] ?? 0) + inputs[p]!
      s.at++
    },
    hash: (s) => (s.at * 31 + s.pos.reduce((a, b) => a + b, 0)) | 0,
    snapshot: (s) => [s.at, ...s.pos],
    restore: (s, d) => {
      if (d.length !== s.pos.length + 1) return false
      s.at = d[0]!
      for (let i = 0; i < s.pos.length; i++) s.pos[i] = d[1 + i]!
      return true
    },
    holds: () => true,
    automate: () => true,
  }
}

const TICK = 50 // 20Hz, so the arithmetic is easy to read
const PLAYERS = 4

function pair() {
  const a = new Authority<Toy>({ sim: toy(PLAYERS), players: PLAYERS, tickMs: TICK, idle: 0 })
  const f = new Follower<Toy>({
    sim: toy(PLAYERS),
    players: PLAYERS,
    tickMs: TICK,
    idle: 0,
    localPlayers: [0],
  })
  return { a, f }
}

describe('following a world somebody else simulates', () => {
  it('answers its own player at once, before the authority has heard', () => {
    // The reason prediction exists. A control that waits a round trip is a
    // control that feels broken, however right it is.
    const { f } = pair()
    f.advance(TICK, (p, at) => f.setLocalInput(p, at, 7))
    expect(f.at).toBe(1)
    expect(f.state.pos[0]).toBe(7)
    expect(f.confirmed).toBe(-1) // nothing confirmed at all yet
  })

  it('lands on exactly what the authority says, once told', () => {
    const { a, f } = pair()
    let now = 0
    for (let t = 0; t < 40; t++) {
      now += TICK
      f.advance(TICK, (p, at) => f.setLocalInput(p, at, 3))
      const run = f.localRun(0, 8)
      a.input(0, run.from, run.f)
      a.input(1, a.at, [5])
      a.advance(TICK)
      expect(f.take(a.frame(0), now)).toBe(true)
      a.holds(0, a.at)
    }
    // The truth it holds is the authority's world exactly.
    expect(f.confirmed).toBe(a.at)
    expect(f.newest()).toEqual(a.frame(1).data)
    // And the prediction sits *ahead* of it, by the input the authority has
    // not accounted for yet. Being level would mean the local player was
    // waiting a round trip, which is the thing prediction exists to avoid.
    expect(f.at).toBeGreaterThan(a.at)
    expect(f.state.pos[0]).toBeGreaterThan(a.state.pos[0]!)
  })

  it('corrects a prediction built on input the authority never got', () => {
    // The prediction is wrong here on purpose: nothing was sent. What matters
    // is that the correction lands rather than drifting for ever.
    const { a, f } = pair()
    for (let t = 0; t < 10; t++) f.advance(TICK, (p, at) => f.setLocalInput(p, at, 9))
    expect(f.state.pos[0]).toBe(90)
    a.advance(TICK)
    expect(f.take(a.frame(0), 1000)).toBe(true)
    // Everything before the authority's point is settled; only what it has not
    // accounted for is re-applied.
    expect(f.state.pos[0]).toBeLessThan(90)
    expect(f.at).toBeGreaterThanOrEqual(a.at)
  })

  it('refuses a difference against a world it is not holding', () => {
    const { f } = pair()
    expect(f.take({ at: 9, from: 4, data: [0, 0] }, 0)).toBe(false)
  })

  it('has nothing to blend until it has been told twice', () => {
    // Drawing the newest world on its own is the right answer to that, and it
    // is the caller's — but it has to be able to tell.
    const { a, f } = pair()
    expect(f.between(0)).toBeNull()
    a.advance(TICK)
    f.take(a.frame(0), 100)
    a.holds(0, a.at)
    expect(f.between(100)).toBeNull()
    a.advance(TICK)
    f.take(a.frame(0), 150)
    expect(f.between(150)).not.toBeNull()
  })

  it('draws behind the newest truth, which is what keeps it smooth', () => {
    // Rendering the newest frame directly is the classic mistake: frames land
    // at the authority's rate and not the screen's, so everything jerks.
    const { a, f } = pair()
    let now = 0
    for (let t = 0; t < 6; t++) {
      now += TICK
      a.input(1, a.at, [10])
      a.advance(TICK)
      f.take(a.frame(0), now)
      a.holds(0, a.at)
    }
    const between = f.between(now)!
    // Between two worlds, and behind the newest one.
    expect(between.a[2]).toBeLessThan(f.newest()[2]!)
    expect(between.alpha).toBeGreaterThanOrEqual(0)
    expect(between.alpha).toBeLessThanOrEqual(1)
  })

  it('never waits for a peer, however far behind they are', () => {
    // The whole difference from a rollback: there is no peer to be too far
    // ahead of, because no peer is being simulated.
    const { f } = pair()
    for (let t = 0; t < 500; t++) f.advance(TICK, (p, at) => f.setLocalInput(p, at, 1))
    expect(f.at).toBe(500)
  })

  it('forgets what the authority has already accounted for', () => {
    // Housekeeping rather than correctness — input behind the truth is never
    // read again, because a rebuild starts at the truth and walks forward. But
    // never dropping it is a map that grows for the length of the match, and
    // that is the shape of leak nothing notices until a long game.
    const { a, f } = pair()
    let now = 0
    for (let t = 0; t < 500; t++) {
      now += TICK
      f.advance(TICK, (p, at) => f.setLocalInput(p, at, 1))
      const run = f.localRun(0, 8)
      a.input(0, run.from, run.f)
      a.advance(TICK)
      f.take(a.frame(0), now)
      a.holds(0, a.at)
    }
    const kept = (f as unknown as { mine: Map<number, number>[] }).mine[0]!.size
    expect(f.at).toBeGreaterThan(400)
    expect(kept).toBeLessThan(20)
  })
})
