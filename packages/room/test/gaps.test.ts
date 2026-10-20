// Points nobody ever speaks for.
//
// Two ways a point in a rollback match ends up with no input from a place that
// was answerable for it, and in both every peer waits on it for ever: nothing
// settles past it, no fingerprint is taken, and the match comes back only when
// everybody is rebuilt from the room.
//
// A client that plays more points in a frame than it resends. A frame can play
// a few dozen after a stall or a tab coming back; a message carried only the
// newest couple of dozen, so the rest never left the machine.
//
// And somebody who goes. Their place is handed to the computer a window past
// their last word, so peers already running ahead on a guess can still reach the
// change — and the points in between are owed by somebody who is not coming
// back.

import { describe, it, expect } from 'vitest'
import { Match, Room, rollbackClock } from '../src/index.ts'
import { Rollback, type Sim } from '../src/rollback.ts'

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
    holds: (s, p) => s.driving[p] === true,
    automate: (s, p, on) => {
      s.driving[p] = !on
      return true
    },
  }
}

const WINDOW = 14

function engine(players: number, local: number[]) {
  return new Rollback<Toy>({
    patienceMs: 1e9,
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

describe('a client with a backlog', () => {
  it('sends every point it played, oldest first, however many one frame played', () => {
    const r = engine(2, [0])
    // Player 1 is far ahead, so this end catches up: a few dozen points a frame.
    r.applyRemote(1, 0, new Array<number>(400).fill(1))
    const sent = new Map<number, number>()
    for (let frame = 0; frame < 40; frame++) {
      r.advance(16 * 12, (p, at) => r.setLocalInput(p, at, at % 7))
      const run = r.outbox(0, 24, 64)
      run.f.forEach((v, i) => sent.set(run.from + i, v))
    }
    expect(r.at).toBeGreaterThan(300)
    for (let t = 0; t < r.at; t++) expect(sent.get(t), `point ${t}`).toBe(t % 7)
  })

  it('which a resend of only the newest never did', () => {
    // The control: the same frames, sent the old way, leave holes.
    const r = engine(2, [0])
    r.applyRemote(1, 0, new Array<number>(400).fill(1))
    const sent = new Set<number>()
    for (let frame = 0; frame < 40; frame++) {
      r.advance(16 * 12, (p, at) => r.setLocalInput(p, at, at % 7))
      const run = r.localRun(0, 24)
      run.f.forEach((_, i) => sent.add(run.from + i))
    }
    let holes = 0
    for (let t = 0; t < r.at; t++) if (!sent.has(t)) holes++
    expect(holes).toBeGreaterThan(0)
  })

  it('still carries the redundancy once it has caught up', () => {
    const r = engine(1, [0])
    for (let t = 0; t < 100; t++) {
      r.advance(16, (p, at) => r.setLocalInput(p, at, 1))
      r.outbox(0, 24, 64)
    }
    const run = r.outbox(0, 24, 64)
    expect(run.f.length).toBe(24)
    expect(run.from + run.f.length - 1).toBe(r.at - 1)
  })
})

describe('somebody who has gone', () => {
  const START = 100_000

  function playing(): Match {
    const m = new Match({ players: 4, clock: rollbackClock({ window: WINDOW, slack: 4 }), silenceMs: 4000 })
    m.begin({ roster: 2, playing: [0, 1], now: START })
    for (let t = 0; t <= 99; t++) {
      m.contribute(0, t, [1], START)
      m.contribute(1, t, [t === 99 ? 5 : 1], START)
    }
    return m
  }

  it('is owed a stand-in for the points before their place changed hands', () => {
    const m = playing()
    const [h] = m.leave(1, START)
    m.seal(1)
    // Nobody has played past 99 yet, so nothing is due.
    expect(m.takeFills()).toEqual([])
    // The others play on, and the stand-in follows them, never ahead.
    for (let t = 100; t < h!.at + 10; t++) {
      m.contribute(0, t, [1], START)
      for (const f of m.takeFills()) {
        expect(f.player).toBe(1)
        expect(f.from + f.run.length - 1).toBeLessThanOrEqual(m.head)
      }
    }
    // Every point up to the change is now written, with their last word.
    const log = m.catchup().log
    for (let t = 100; t < h!.at; t++) expect(log[1]![t], `point ${t}`).toBe(5)
  })

  it('writes what a latecomer replaying the log would read anyway', () => {
    const a = playing()
    const b = playing()
    a.leave(1, START)
    a.seal(1)
    b.leave(1, START)
    for (let t = 100; t < 160; t++) {
      a.contribute(0, t, [1], START)
      a.takeFills()
      b.contribute(0, t, [1], START)
    }
    expect(a.catchup().log).toEqual(b.catchup().log)
  })

  it('cannot have those points rewritten by whatever arrives later', () => {
    const m = playing()
    const [h] = m.leave(1, START)
    m.seal(1)
    for (let t = 100; t < h!.at + 5; t++) {
      m.contribute(0, t, [1], START)
      m.takeFills()
    }
    expect(m.settle(1, 100, [9, 9, 9])).toEqual([5, 5, 5])
    // Past the stand-in it is theirs again.
    expect(m.settle(1, h!.at + 50, [9])).toEqual([9])
  })

  it('is filled after going quiet first, which leaves the same gap', () => {
    const m = playing()
    const quiet = m.observe([0, 1], START + 5000)
    expect(quiet.map((q) => q.p)).toContain(1)
    m.seal(1)
    let filled = 0
    for (let t = 100; t < 200; t++) {
      m.contribute(0, t, [1], START + 5000)
      for (const f of m.takeFills()) filled += f.run.length
    }
    expect(filled).toBeGreaterThan(0)
  })
})

describe('a room somebody leaves', () => {
  it('says what is owed for them, as input to send', () => {
    type Who = string
    const held = new Map<Who, { chairs: number[]; players: number[] }>([
      ['a', { chairs: [0], players: [0] }],
      ['b', { chairs: [1], players: [1] }],
    ])
    const room = new Room<Who, null, number>({
      capacity: 4,
      roster: 4,
      silenceMs: 4000,
      recall: 64,
      heartbeatMs: 45_000,
      clock: rollbackClock({ window: WINDOW, slack: 4 }),
      settings: null,
      checkSettings: () => null,
      checkSeat: (s) => (s === 0 || s === 1 ? s : null),
      members: () =>
        [...held].map(([who, h]) => ({ who, chairs: h.chairs, name: who, seats: h.chairs.map((c) => c % 2), players: h.players })),
      name: (n) => n,
    })
    room.arrive('a', { name: 'a', build: 'x', announce: false, code: 'T' }, 0)
    room.arrive('b', { name: 'b', build: 'x', announce: false, code: 'T' }, 0)
    room.begin('a', 2, 0)
    for (let t = 0; t < 50; t++) {
      room.input('a', 0, t, [1], 0)
      room.input('b', 1, t, [2], 0)
    }
    const gone = room.depart('b', { name: 'b', players: [1] }, 0)
    held.delete('b')
    expect(gone.some((d) => d.kind === 'handovers')).toBe(true)
    const filled: number[] = []
    for (let t = 50; t < 90; t++) {
      for (const d of room.input('a', 0, t, [1], 0)) {
        if (d.kind === 'filled') for (const f of d.fills) f.run.forEach((v, i) => filled.push(f.from + i, v))
      }
    }
    expect(filled.length).toBeGreaterThan(0)
    for (let i = 1; i < filled.length; i += 2) expect(filled[i]).toBe(2)
  })
})

describe('a machine that went quiet', () => {
  it('has the points before its takeover settled by the room straight away', () => {
    const m = new Match({ players: 4, clock: rollbackClock({ window: WINDOW, slack: 4 }), silenceMs: 4000 })
    const START = 100_000
    m.begin({ roster: 2, playing: [0, 1], now: START })
    for (let t = 0; t <= 99; t++) {
      m.contribute(0, t, [1], START)
      m.contribute(1, t, [3], START)
    }
    // Player 0 runs on a guess, as far as the window allows.
    for (let t = 100; t <= 99 + WINDOW; t++) m.contribute(0, t, [1], START + 5000)
    const quiet = m.observe([0, 1], START + 5000)
    expect(quiet.map((q) => q.p)).toEqual([1])
    const fills = m.takeFills()
    expect(fills.length).toBe(1)
    expect(fills[0]!.from).toBe(100)
    expect(fills[0]!.run.every((v) => v === 3)).toBe(true)
    // What they say about those points when they wake is not what is played.
    expect(m.settle(1, 100, [7, 7])).toEqual([3, 3])
  })

  it('replays what the room settled for it, not what it sampled', () => {
    const r = engine(2, [0])
    // The room has written points 10-19 for our own place while we were away.
    r.applyRemote(0, 10, new Array<number>(10).fill(4))
    r.applyRemote(1, 0, new Array<number>(40).fill(1))
    r.advance(16 * 12, (p, at) => r.setLocalInput(p, at, 9))
    r.advance(16 * 12, (p, at) => r.setLocalInput(p, at, 9))
    const run = r.outbox(0, 24, 64)
    for (let t = 10; t < 20; t++) expect(run.f[t - run.from], `point ${t}`).toBe(4)
    expect(run.f[0]).toBe(9)
  })
})
