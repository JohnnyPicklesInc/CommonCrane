// One machine simulates and describes; everybody else applies what they are
// sent. What is checked here is that the description is enough — that a client
// holding nothing but frames arrives at the same world, and that it is told
// rather than left guessing when it cannot.

import { describe, it, expect } from 'vitest'
import { Authority, apply, type Frame } from '../src/authority.ts'
import type { Sim } from '../src/rollback.ts'

/** A state with a little of everything: something per player, and a total. */
interface Toy {
  at: number
  sum: number
  pos: number[]
}

function toy(players: number): Sim<Toy> {
  return {
    create: () => ({ at: 0, sum: 0, pos: new Array<number>(players).fill(0) }),
    clone: (s) => ({ at: s.at, sum: s.sum, pos: [...s.pos] }),
    copy: (into, from) => {
      into.at = from.at
      into.sum = from.sum
      for (let i = 0; i < from.pos.length; i++) into.pos[i] = from.pos[i]!
    },
    pointOf: (s) => s.at,
    step: (s, inputs) => {
      for (let p = 0; p < inputs.length; p++) {
        s.pos[p] = (s.pos[p] ?? 0) + inputs[p]!
        s.sum += inputs[p]!
      }
      s.at++
    },
    hash: (s) => (s.sum * 31 + s.at) | 0,
    snapshot: (s) => [s.at, s.sum, ...s.pos],
    restore: (s, d) => {
      // Exactly, the way a real one does: a world of the wrong shape is one
      // from a different build, and filling in what fits is worse than saying no.
      if (d.length !== s.pos.length + 2) return false
      s.at = d[0]!
      s.sum = d[1]!
      for (let i = 0; i < s.pos.length; i++) s.pos[i] = d[2 + i]!
      return true
    },
    holds: () => true,
    automate: () => true,
  }
}

const TICK = 16
function authority(players: number, remember = 64) {
  return new Authority<Toy>({ sim: toy(players), players, tickMs: TICK, idle: 0, remember })
}

/** A client that holds only what it has been sent. */
function client() {
  const world: number[] = []
  let at = -1
  return {
    get world() {
      return world
    },
    get at() {
      return at
    },
    take(f: Frame): boolean {
      const next = apply(f.from === -1 ? null : f.from === at ? world : null, f)
      if (next === null) return false
      world.length = 0
      for (const v of next) world.push(v)
      at = f.at
      return true
    },
  }
}

describe('one machine simulating for everybody', () => {
  it('sends the whole world to somebody holding nothing', () => {
    const a = authority(2)
    const f = a.frame(0)
    expect(f.from).toBe(-1)
    expect(f.data.length).toBeGreaterThan(0)
  })

  it('brings a client to exactly the world the authority holds', () => {
    const a = authority(4)
    const c = client()
    for (let t = 0; t < 200; t++) {
      a.input(0, a.at, [t % 3])
      a.input(1, a.at, [1])
      a.advance(TICK)
      const f = a.frame(0)
      expect(c.take(f)).toBe(true)
      a.holds(0, f.at)
    }
    // The world they hold is the world it wrote down. Player 3 has confirmed
    // nothing, so what it would send them is the whole of it.
    const whole = a.frame(3)
    expect(whole.from).toBe(-1)
    expect(c.world).toEqual(whole.data)
  })

  it('sends a difference once they have something to measure against', () => {
    // Sixteen players so the saving is visible: one of them moves, and the
    // difference is that one and the two numbers the whole room shares.
    const a = authority(16)
    const c = client()
    c.take(a.frame(0))
    a.holds(0, a.at)
    a.input(0, a.at, [5])
    a.advance(TICK)
    const f = a.frame(0)
    expect(f.from).toBe(0)
    // Only what moved: the point, the total, and the one player who acted —
    // three pairs, against eighteen numbers for the whole world.
    expect(f.data.length).toBe(6)
    expect(a.frame(3).data.length).toBe(18)
    expect(c.take(f)).toBe(true)
  })

  it('falls back to the whole world rather than refusing an old client', () => {
    // A bad connection should be slow, not broken. Somebody who has confirmed
    // nothing inside the window gets everything, which always applies.
    const a = authority(2, 8)
    const c = client()
    c.take(a.frame(0))
    a.holds(0, 0)
    for (let t = 0; t < 40; t++) {
      a.input(0, a.at, [1])
      a.advance(TICK)
    }
    const f = a.frame(0)
    expect(f.from).toBe(-1)
    expect(c.take(f)).toBe(true)
    expect(c.world).toEqual(a.frame(1).data)
  })

  it('refuses a difference against a world the client is not holding', () => {
    // Applying it anyway is the one thing that must not happen: it produces a
    // world nobody has, that looks plausible and diverges silently.
    const a = authority(2)
    const c = client()
    c.take(a.frame(0))
    a.holds(0, 0)
    a.input(0, 0, [7])
    a.advance(TICK)
    a.input(0, 1, [7])
    a.advance(TICK)
    const skipped = a.frame(0) // measured from 0, but the client is at 0 — apply
    expect(c.take(skipped)).toBe(true)
    // Now hand it one measured from a point it never reached.
    expect(c.take({ at: 99, from: 50, data: [0, 0] })).toBe(false)
  })

  it('keeps playing a player who has stopped speaking, on their last input', () => {
    // Never corrected, because this world is the only one there is — which is
    // the whole difference from a rollback, where the same guess is a
    // prediction waiting to be contradicted.
    const a = authority(2)
    a.input(0, 0, [3])
    a.advance(TICK)
    const after = a.state.pos[0]
    for (let t = 0; t < 5; t++) a.advance(TICK)
    expect(a.state.pos[0]).toBe(after! + 3 * 5)
  })

  it('ignores anything said about a point already played', () => {
    // There is no rewinding here. A frame describing that point has already
    // gone out, and rewriting it is what this design exists to avoid.
    const a = authority(2)
    a.advance(TICK)
    a.advance(TICK)
    const before = a.hash()
    a.input(0, 0, [99])
    a.advance(TICK)
    a.input(0, 1, [99])
    expect(a.hash()).not.toBe(before) // it did advance
    expect(a.state.pos[0]).toBe(0) // but nothing from the past landed
  })

  it('carries on from a world rather than starting again', () => {
    // Taking over. Whoever was simulating has gone, and the match continues
    // from where they left it — starting again from the beginning would put
    // everybody back at the spawn with the score reset.
    const a = authority(4)
    for (let t = 0; t < 30; t++) {
      a.input(0, a.at, [2])
      a.advance(TICK)
    }
    const world = a.frame(99).data
    const b = new Authority<Toy>({
      sim: toy(4),
      players: 4,
      tickMs: TICK,
      idle: 0,
      from: world,
    })
    expect(b.at).toBe(a.at)
    expect(b.frame(99).data).toEqual(world)
  })

  it('starts fresh rather than half filled in, given a world it cannot read', () => {
    // Wrong in a way somebody can see, rather than a state part built from
    // somebody else's build and diverging from the first point.
    const b = new Authority<Toy>({ sim: toy(4), players: 4, tickMs: TICK, idle: 0, from: [1, 2] })
    expect(b.at).toBe(0)
  })
})
