// The stall rule, against a simulation small enough to reason about.
//
// The engine is covered end to end by a real game elsewhere, which is the only
// way to know it plays the same match. What that cannot show is a rule holding
// for a game with different constants — and the constants are exactly where
// this one went wrong.

import { describe, it, expect } from 'vitest'
import { Rollback, type Sim } from '../src/rollback.ts'

/** A state that is nothing but a running total and who is driving. */
interface Toy {
  at: number
  sum: number
  driving: boolean[]
}

function toy(players: number): Sim<Toy> {
  return {
    create: () => ({ at: 0, sum: 0, driving: new Array<boolean>(players).fill(true) }),
    clone: (s) => ({ at: s.at, sum: s.sum, driving: [...s.driving] }),
    copy: (into, from) => {
      into.at = from.at
      into.sum = from.sum
      for (let i = 0; i < from.driving.length; i++) into.driving[i] = from.driving[i]!
    },
    pointOf: (s) => s.at,
    step: (s, inputs) => {
      for (let p = 0; p < inputs.length; p++) if (s.driving[p]) s.sum += inputs[p]!
      s.at++
    },
    hash: (s) => (s.sum * 31 + s.at) | 0,
    snapshot: (s) => [s.at, s.sum, ...s.driving.map((d) => (d ? 1 : 0))],
    restore: (s, d) => {
      if (d.length < 2) return false
      s.at = d[0]!
      s.sum = d[1]!
      for (let i = 0; i < s.driving.length; i++) s.driving[i] = d[2 + i] === 1
      return true
    },
    holds: (s, p) => s.driving[p] === true,
    automate: (s, p, on) => {
      s.driving[p] = !on
      return true
    },
  }
}

const WINDOW = 14

/**
 * `patienceMs` is enormous by default here so that a stall can be *observed*.
 * Waiting is bounded in a real game — see the tests that say so — and most of
 * these are about which places are worth waiting for at all, which is a
 * separate question from how long.
 */
function engine(players: number, local: number[], patienceMs = 1e9) {
  return new Rollback<Toy>({
    patienceMs,
    sim: toy(players),
    players,
    localPlayers: local,
    window: WINDOW,
    tickMs: 16,
    idle: 0,
    hashEvery: 60,
    snapshotEvery: 300,
    catchupSlack: 2,
    catchupPerFrame: 40,
  })
}

/** Play forward, with player 1 falling silent after `until`. */
function run(r: ReturnType<typeof engine>, ticks: number, until: number, decide?: (t: number) => void) {
  for (let t = 0; t < ticks; t++) {
    if (t <= until) r.applyRemote(1, t, [1])
    r.setLocalInput(0, t, 1)
    r.advance(16, () => {})
    decide?.(t)
  }
}

describe('waiting for somebody who has gone', () => {
  it('stops dead without a decision, which is what the decision is for', () => {
    const r = engine(2, [0])
    run(r, 400, 99)
    expect(r.stalled).toBe(true)
    // The horizon: the last point where being any further ahead would put us
    // more than a window past their newest input.
    expect(r.at).toBe(99 + WINDOW + 1)
  })

  it('carries on once the room says the place is the computer’s', () => {
    const r = engine(2, [0])
    run(r, 400, 99, (t) => {
      if (t === 150) r.handover(1, 99 + 12, true)
    })
    expect(r.stalled).toBe(false)
    expect(r.at).toBeGreaterThan(300)
  })

  it('carries on even when the point named is past the horizon', () => {
    // The one that matters, and the reason the rule reads the decision on
    // arrival rather than at the point it names. A game whose takeover grace is
    // larger than its prediction window names a point its peers cannot reach:
    // stalled at their last input plus fourteen, nobody ever plays the
    // eighteenth, so the handover is never applied and the wait never ends.
    //
    // Two games in this family picked those two constants. Neither would have
    // diagnosed it from the symptom, which is that the match quietly stops.
    const r = engine(2, [0])
    run(r, 400, 99, (t) => {
      if (t === 150) r.handover(1, 99 + WINDOW + 4, true)
    })
    expect(r.stalled).toBe(false)
    expect(r.at).toBeGreaterThan(300)
  })

  it('waits again when the place is handed back', () => {
    // Somebody has returned, so they are worth waiting for once more — and the
    // nudge is what stops them being counted late for the time they were away.
    const r = engine(2, [0])
    run(r, 400, 99, (t) => {
      if (t === 150) r.handover(1, 99 + 12, true)
      if (t === 300) r.handover(1, r.at + 12, false)
    })
    const after = r.at
    run(r, 200, -1)
    expect(r.stalled).toBe(true)
    expect(r.at).toBeLessThan(after + 200)
  })

  it('stops waiting for a place the connection itself has lost', () => {
    // Not a decision and not simulated. The room's decisions arrive over the
    // same connection whose loss is the problem, so when the socket dies there
    // is nobody left to say that nobody is left — and without this the game
    // freezes within a window of a tab closing, with nothing on screen to
    // explain it.
    const r = engine(2, [0])
    run(r, 400, 99, (t) => {
      if (t === 150) r.unreachable(1)
    })
    expect(r.stalled).toBe(false)
    expect(r.at).toBeGreaterThan(300)
  })

  it('stops waiting for a place a whole assignment took away, at once', () => {
    // The one that froze a real game. Somebody swaps benches, so they stop
    // speaking for the place they left — and a client that has not yet played
    // the point the assignment names goes on waiting for it. It cannot reach
    // that point, because it is waiting.
    const r = engine(2, [0])
    run(r, 400, 99)
    expect(r.stalled).toBe(true)
    // The room says place 1 is nobody's, from a point still ahead of us.
    r.lineup(r.at + 40, [0], [0])
    run(r, 400, -1)
    expect(r.stalled).toBe(false)
    expect(r.at).toBeGreaterThan(300)
  })

  it('waits again for a place a whole assignment gave to somebody', () => {
    // The other direction has to still hold: somebody is answerable for it now.
    const r = engine(2, [0])
    run(r, 200, 99)
    r.lineup(r.at + 20, [0, 1], [0, 1])
    run(r, 200, -1)
    expect(r.stalled).toBe(true)
  })

  it('has something to say the moment it is given a place', () => {
    // The deadlock. Everybody else starts waiting on whoever was just given a
    // place; that machine cannot say anything, because saying it means having
    // sampled and sampling happens inside the advance the waiting has stopped.
    // Both sides wait for each other and only giving the place back ends it.
    const r = engine(2, [])
    // Nobody is in place 1, and nobody ever has been — which is what a place a
    // watcher is about to be given looks like.
    r.handover(1, 0, true)
    run(r, 100, -1)
    expect(r.localRun(1, 8).f.length).toBe(0)
    // Given it, on a point a little ahead, as a room dates it.
    r.handover(1, r.at + 12, false)
    // There is something to send for it at once, rather than only after a point
    // has been played that may never be reached.
    expect(r.localRun(1, 8).f.length).toBeGreaterThan(0)
  })

  it('and nobody counts them late for the time before they had it', () => {
    const r = engine(2, [0])
    // Place 1 is the computer's from the start, which is what a place nobody
    // is in looks like — so there is nobody to wait for.
    r.handover(1, 0, true)
    run(r, 200, -1)
    expect(r.stalled).toBe(false)
    // And now it is somebody's. They have never said a word, and the two
    // hundred points before it was theirs are not theirs to be late for.
    r.handover(1, r.at + 12, false)
    run(r, 20, -1)
    expect(r.stalled).toBe(false)
  })

  it('carries on without somebody it has waited long enough for', () => {
    // The prediction window is a hard mutual dependency: everybody stops for
    // whoever is furthest behind, so one machine in trouble stops the room.
    // Right for a moment, wrong for ever, and the difference is only time.
    const r = engine(2, [0], 1000)
    // Stopped, and still inside the time it is willing to wait.
    run(r, 130, 99)
    expect(r.stalled).toBe(true)
    const stuck = r.at
    // Past it, and going again.
    run(r, 150, -1)
    expect(r.stalled).toBe(false)
    expect(r.at).toBeGreaterThan(stuck + 50)
  })

  it('waits for them again the moment they say anything', () => {
    const r = engine(2, [0], 1000)
    run(r, 130, 99)
    run(r, 150, -1)
    expect(r.stalled).toBe(false)
    // Back, and worth waiting for again — the patience starts over with them.
    r.applyRemote(1, r.at, [1])
    run(r, 40, -1)
    expect(r.stalled).toBe(true)
  })

  it('says which place it is stopped for, and how far behind', () => {
    // "Waiting for a peer" and "waiting for the second place, four hundred
    // points behind" are the same fact, and only one of them is any use when a
    // match has frozen and somebody has to work out why.
    const r = engine(3, [0])
    run(r, 300, 99)
    const on = r.waitingOn()
    expect(on.length).toBeGreaterThan(0)
    expect(on[0]!.behind).toBeGreaterThan(WINDOW)
  })

  it('is not kept waiting for ever by somebody repeating themselves', () => {
    // The one that froze a real match. Every message carries a couple of dozen
    // points of redundancy, so a client that has itself stopped goes on sending
    // the same run for ever. Counted as "they are back", it resets the patience
    // on every frame and the wait never ends: two machines each waiting on the
    // other, each hearing the other often enough to keep waiting.
    const r = engine(2, [0], 1000)
    run(r, 130, 99)
    expect(r.stalled).toBe(true)
    // Their last words, over and over, exactly as a stopped client sends them.
    for (let i = 0; i < 200; i++) {
      r.applyRemote(1, 92, [1, 1, 1, 1, 1, 1, 1, 1])
      r.setLocalInput(0, r.at, 1)
      r.advance(16, () => {})
    }
    expect(r.stalled).toBe(false)
  })
})
