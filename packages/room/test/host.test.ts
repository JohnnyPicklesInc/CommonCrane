// The glue, against fakes. Like `durable.ts` it decides nothing, so what is
// checked is that it does not lose anything — and that it does not quietly take
// over a decision that belongs to the game.

import { describe, it, expect, vi } from 'vitest'
import { Host, heartbeat, type Peers } from '../src/host.ts'
import type { Decision } from '../src/room.ts'
import type { LobbyState } from '../src/lobby.ts'

// A game's own shape, deliberately not the library's — the point being that
// there isn't one.
interface Whatever {
  slots: number[]
  name: string
  players: number[]
}
const blank: Whatever = { slots: [], name: '?', players: [] }

type Settings = { mode: number }
type Say = Decision<string, Settings, number>

/** A peer set the test moves about, standing in for a runtime's socket list. */
function peers(...names: string[]) {
  const attachments = new Map<string, Whatever>()
  const sent = new Map<string, string[]>()
  const dead = new Set<string>()
  const p: Peers<string, Whatever> = {
    all: () => names,
    attachment: (who) => attachments.get(who) ?? null,
    attach: (who, held) => void attachments.set(who, held),
    send: (who, payload) => {
      if (dead.has(who)) throw new Error('gone')
      const box = sent.get(who) ?? []
      box.push(payload)
      sent.set(who, box)
    },
  }
  return { p, sent, dead, of: (who: string) => sent.get(who) ?? [] }
}

function host(said: Say[], set = peers('a', 'b')) {
  return {
    ...set,
    h: new Host<string, Settings, number, Whatever>({
      peers: set.p,
      blank,
      say: (d) => said.push(d),
    }),
  }
}

describe('what a connection holds', () => {
  it('reads as empty rather than null on a connection nothing has been put on', () => {
    const said: Say[] = []
    expect(host(said).h.held('a')).toEqual(blank)
  })

  it('changes one field and leaves the rest standing', () => {
    // The whole reason this is a method. Six places in one game were spreading
    // the old attachment over a new one by hand, and one short spread loses
    // somebody's name with the type checker perfectly happy.
    const said: Say[] = []
    const { h } = host(said)
    h.hold('a', { name: 'Alice', slots: [0] })
    h.hold('a', { players: [2] })
    expect(h.held('a')).toEqual({ name: 'Alice', slots: [0], players: [2] })
  })
})

describe('sending', () => {
  it('does not take the handler down when a connection has gone', () => {
    // A connection can die between being chosen and being written to. Throwing
    // loses the other nine people's copy of whatever it was.
    const said: Say[] = []
    const { h, dead, of } = host(said)
    dead.add('a')
    expect(() => h.broadcast({ t: 'x' })).not.toThrow()
    expect(of('b')).toEqual(['{"t":"x"}'])
    expect(() => h.sendTo('a', { t: 'x' })).not.toThrow()
  })

  it('spares one when asked', () => {
    const said: Say[] = []
    const { h, of } = host(said)
    h.broadcast({ t: 'x' }, 'a')
    expect(of('a')).toEqual([])
    expect(of('b').length).toBe(1)
  })

  it('serialises a broadcast once', () => {
    // The hot path: an input echo goes to everybody at sixty a second, and
    // stringifying the same message per recipient is the one wasteful thing at
    // that rate that is easy not to do.
    const said: Say[] = []
    const set = peers('a', 'b', 'c')
    const { h } = host(said, set)
    const msg = { t: 'in', p: 1, f: [1, 2, 3] }
    const spy = vi.spyOn(JSON, 'stringify')
    h.broadcast(msg)
    expect(spy.mock.calls.filter((c) => c[0] === msg).length).toBe(1)
    spy.mockRestore()
  })
})

describe('carrying out what the room decided', () => {
  it('takes the four that are about being a host', () => {
    const said: Say[] = []
    const saves: unknown[] = []
    const wakes: (number | null)[] = []
    const lists: unknown[] = []
    let recycled = 0
    const set = peers('a')
    const h = new Host<string, Settings, number, Whatever>({
      peers: set.p,
      blank,
      save: (state, started) => saves.push({ state, started }),
      wake: (inMs) => wakes.push(inMs),
      list: (entry, code) => lists.push({ entry, code }),
      recycle: () => recycled++,
      say: (d) => said.push(d),
    })
    const state: LobbyState<Settings> = {
      settings: { mode: 1 },
      announced: false,
      build: 'v1',
      code: 'ABCD',
      since: 0,
      places: 2,
    }
    h.carry([
      { kind: 'remember', state, started: true },
      { kind: 'wake', inMs: 1000 },
      { kind: 'listed', entry: null, code: 'ABCD' },
      { kind: 'recycle' },
    ])
    expect(saves).toEqual([{ state, started: true }])
    expect(wakes).toEqual([1000])
    expect(lists).toEqual([{ entry: null, code: 'ABCD' }])
    expect(recycled).toBe(1)
  })

  it('passes the host-shaped ones on as well rather than swallowing them', () => {
    // A game may perfectly well want to know its room has just been listed or
    // recycled. Handling one here is not a reason to stop telling anybody.
    const said: Say[] = []
    const { h } = host(said)
    h.carry([{ kind: 'recycle' }])
    expect(said.map((d) => d.kind)).toEqual(['recycle'])
  })

  it('leaves every decision that is a thing to say to the game', () => {
    // The refusal that matters. Twelve of the sixteen are somebody's news, and
    // what to call it is the game's vocabulary — six games, six protocols. A
    // library that phrased them would be wrong for all six.
    const said: Say[] = []
    const { h, of } = host(said)
    h.carry([
      { kind: 'arrived', who: 'a', name: 'Alice' },
      { kind: 'seated', who: 'a', chairs: [0] },
      { kind: 'disagreed', at: 42 },
    ])
    expect(said.map((d) => d.kind)).toEqual(['arrived', 'seated', 'disagreed'])
    // And nothing was sent on the game's behalf.
    expect(of('a')).toEqual([])
    expect(of('b')).toEqual([])
  })

  it('carries whoever caused it through to the game', () => {
    // So a game can spare somebody a broadcast of their own news, which is what
    // the `except` on a broadcast is for.
    const said: [Say, string | undefined][] = []
    const set = peers('a', 'b')
    const h = new Host<string, Settings, number, Whatever>({
      peers: set.p,
      blank,
      say: (d, from) => said.push([d, from]),
    })
    h.carry([{ kind: 'arrived', who: 'a', name: 'Alice' }], 'a')
    expect(said[0]![1]).toBe('a')
  })

  it('does not require a host to care about any of the four', () => {
    // A host with nothing to persist and no board to be on is a legitimate
    // host — an offline game, or a test.
    const said: Say[] = []
    const { h } = host(said)
    expect(() =>
      h.carry([
        { kind: 'wake', inMs: null },
        { kind: 'recycle' },
      ]),
    ).not.toThrow()
  })
})

describe('the heartbeat', () => {
  it('brings a pending one forward when asked for sooner', () => {
    // The bug this replaced. A room asks rarely while it is a lobby and often
    // once a match is running; a pending lobby-length wake swallowed every
    // request for a shorter one, so the room went on being looked at once a
    // minute for the whole match and nobody was ever noticed going quiet.
    vi.useFakeTimers()
    let looks = 0
    const b = heartbeat(() => looks++)
    b.wake(45_000)
    b.wake(1000)
    vi.advanceTimersByTime(1001)
    expect(looks).toBe(1)
    b.stop()
    vi.useRealTimers()
  })

  it('leaves a pending one alone rather than pushing it further out', () => {
    // Rescheduling on every call is how a busy room never gets looked at: each
    // message moves the beat out again and it never arrives.
    vi.useFakeTimers()
    let looks = 0
    const b = heartbeat(() => looks++)
    b.wake(1000)
    for (let i = 0; i < 10; i++) b.wake(45_000)
    vi.advanceTimersByTime(1001)
    expect(looks).toBe(1)
    b.stop()
    vi.useRealTimers()
  })

  it('stops when the room says it wants nothing', () => {
    vi.useFakeTimers()
    let looks = 0
    const b = heartbeat(() => looks++)
    b.wake(1000)
    b.wake(null)
    vi.advanceTimersByTime(5000)
    expect(looks).toBe(0)
    vi.useRealTimers()
  })

  it('can be asked for another once one has fired', () => {
    // The beat that schedules the next beat. A pending one is cleared when it
    // fires, so the following request has nothing to compare against — and one
    // that took the stale deadline as still pending would never fire again.
    vi.useFakeTimers()
    let looks = 0
    const b = heartbeat(() => looks++)
    b.wake(1000)
    vi.advanceTimersByTime(1001)
    b.wake(1000)
    vi.advanceTimersByTime(1001)
    expect(looks).toBe(2)
    b.stop()
    vi.useRealTimers()
  })
})
