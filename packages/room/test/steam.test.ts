// Getting to a room over Steam, against a fake.
//
// No Steam here and none possible: `Messages` is four operations and this
// supplies them out of a Map, which is the whole point of the interface being
// that narrow. What is checked is the two things a transport can silently get
// wrong — putting a message on the wrong channel, and losing one without saying
// so — plus the ordering property that makes a listen host safe.

import { describe, it, expect } from 'vitest'
import {
  SteamTransport,
  loopback,
  steamPeers,
  CONTROL,
  INPUT,
  type Messages,
  type Received,
} from '../src/steam.ts'
import { Host } from '../src/host.ts'
import { Room, type Member, type Decision } from '../src/room.ts'
import { rollbackClock } from '../src/schedule.ts'

type Out = { t: string; n?: number }
type In = { t: string; n?: number }

/** Everything asked of Steam, and everything we pretend it said. */
function steam() {
  const sent: { to: string; payload: string; channel: number; reliable: boolean }[] = []
  const inbox = new Map<number, Received[]>()
  const accepted: string[] = []
  const closed: string[] = []
  let refuse = false
  const s: Messages = {
    me: () => 'me',
    send: (to, payload, channel, reliable) => {
      if (refuse) return false
      sent.push({ to, payload, channel, reliable })
      return true
    },
    drain: (channel, max) => {
      const box = inbox.get(channel) ?? []
      return box.splice(0, max)
    },
    accept: (who) => void accepted.push(who),
    close: (who) => void closed.push(who),
  }
  return {
    s,
    sent,
    accepted,
    closed,
    /** Pretend something arrived. */
    put: (channel: number, from: string, msg: unknown) => {
      const box = inbox.get(channel) ?? []
      box.push({ from, payload: typeof msg === 'string' ? msg : JSON.stringify(msg) })
      inbox.set(channel, box)
    },
    refuseEverything: () => {
      refuse = true
    },
  }
}

/** After the microtasks a deferred delivery is queued on. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('a room reached over Steam', () => {
  it('accepts the peer on the way up, because nothing flows until it does', () => {
    const f = steam()
    new SteamTransport<Out, In>({ steam: f.s, to: 'host' })
    expect(f.accepted).toEqual(['host'])
  })

  it('puts the hot path on its own channel, unreliably, and nothing else', () => {
    // The reason channels are worth having. An input run heals itself from the
    // frames in the next one, so a late copy is worse than none; a lobby view or
    // a catchup cannot be missed at all. Sent down one ordered stream the two are
    // indistinguishable, and the game is stuck with whichever compromise it
    // picked.
    const f = steam()
    const t = new SteamTransport<Out, In>({
      steam: f.s,
      to: 'host',
      unreliable: (m) => m.t === 'in',
    })
    t.send({ t: 'in', n: 1 })
    t.send({ t: 'startReq' })
    expect(f.sent).toEqual([
      { to: 'host', payload: '{"t":"in","n":1}', channel: INPUT, reliable: false },
      { to: 'host', payload: '{"t":"startReq"}', channel: CONTROL, reliable: true },
    ])
  })

  it('sends everything reliably when the game has not said what is droppable', () => {
    // The default that is merely slow rather than wrong.
    const f = steam()
    const t = new SteamTransport<Out, In>({ steam: f.s, to: 'host' })
    t.send({ t: 'in', n: 1 })
    expect(f.sent[0]!.reliable).toBe(true)
    expect(f.sent[0]!.channel).toBe(CONTROL)
  })

  it('says so when Steam will not take a message', () => {
    // How this actually fails: by size. The interface caps a message well under
    // what a whole match log comes to, so the thing that goes missing is a
    // catchup — and a catchup that vanishes leaves somebody watching a game they
    // can never join, with nothing anywhere saying why.
    const f = steam()
    const refused: Out[] = []
    const t = new SteamTransport<Out, In>({
      steam: f.s,
      to: 'host',
      onRefused: (m) => refused.push(m),
    })
    f.refuseEverything()
    t.send({ t: 'catchup' })
    expect(refused).toEqual([{ t: 'catchup' }])
  })

  it('hands up what arrived, off both channels', () => {
    const f = steam()
    const t = new SteamTransport<Out, In>({ steam: f.s, to: 'host' })
    const got: In[] = []
    t.onMessage = (m) => got.push(m)
    f.put(CONTROL, 'host', { t: 'lobby' })
    f.put(INPUT, 'host', { t: 'in', n: 7 })
    t.pump()
    expect(got).toEqual([{ t: 'lobby' }, { t: 'in', n: 7 }])
  })

  it('drops anything from somebody who is not the room', () => {
    // A client has one peer. Anything else is a stale session from a match that
    // ended, or somebody who should not be talking to us.
    const f = steam()
    const t = new SteamTransport<Out, In>({ steam: f.s, to: 'host' })
    const got: In[] = []
    t.onMessage = (m) => got.push(m)
    f.put(CONTROL, 'stranger', { t: 'lobby' })
    f.put(CONTROL, 'host', { t: 'lobby', n: 1 })
    t.pump()
    expect(got).toEqual([{ t: 'lobby', n: 1 }])
  })

  it('does not tear the match down over a malformed frame', () => {
    const f = steam()
    const t = new SteamTransport<Out, In>({ steam: f.s, to: 'host' })
    const got: In[] = []
    t.onMessage = (m) => got.push(m)
    f.put(CONTROL, 'host', 'not json at all')
    f.put(CONTROL, 'host', { t: 'lobby' })
    expect(() => t.pump()).not.toThrow()
    expect(got).toEqual([{ t: 'lobby' }])
  })

  it('closes once however many times it is asked', () => {
    // A game that tears a match down twice tears down the one it started
    // afterwards. This is also how a caller reports a session that failed, and
    // a failure often arrives alongside the close that follows it.
    const f = steam()
    const t = new SteamTransport<Out, In>({ steam: f.s, to: 'host' })
    let closes = 0
    t.onClose = () => closes++
    t.close()
    t.close()
    expect(closes).toBe(1)
    expect(f.closed).toEqual(['host'])
    expect(t.open).toBe(false)
  })

  it('goes quiet once closed', () => {
    const f = steam()
    const t = new SteamTransport<Out, In>({ steam: f.s, to: 'host' })
    t.close()
    const before = f.sent.length
    t.send({ t: 'in' })
    const got: In[] = []
    t.onMessage = (m) => got.push(m)
    f.put(CONTROL, 'host', { t: 'lobby' })
    t.pump()
    expect(f.sent.length).toBe(before)
    expect(got).toEqual([])
  })
})

describe('a room and a client in the same process', () => {
  it('does not deliver inside the send', async () => {
    // The whole substance of `loopback`. A real socket never calls you back
    // inside your own `send`, and a room part-way through carrying out a list of
    // decisions is not re-entrant: delivered inline, a client can answer the
    // `lobby` before the `begun` behind it has been sent. No remote peer can
    // produce that ordering, so nothing else would ever find it.
    const [room, client] = loopback<Out, In>()
    const got: string[] = []
    client.onMessage = (m) => got.push(m.t)
    room.send({ t: 'lobby' })
    room.send({ t: 'begun' })
    expect(got).toEqual([])
    await settle()
    expect(got).toEqual(['lobby', 'begun'])
  })

  it('carries both ways', async () => {
    const [room, client] = loopback<Out, In>()
    const atRoom: string[] = []
    const atClient: string[] = []
    room.onMessage = (m) => atRoom.push(m.t)
    client.onMessage = (m) => atClient.push(m.t)
    room.send({ t: 'lobby' })
    client.send({ t: 'startReq' })
    await settle()
    expect(atClient).toEqual(['lobby'])
    expect(atRoom).toEqual(['startReq'])
  })

  it('takes the other end down with it, once each', async () => {
    // Losing a socket closes both ends of it, and a pair that closed only its
    // own side would leave a game waiting on a room that has gone.
    const [room, client] = loopback<Out, In>()
    let roomClosed = 0
    let clientClosed = 0
    room.onClose = () => roomClosed++
    client.onClose = () => clientClosed++
    client.close()
    expect(clientClosed).toBe(1)
    expect(roomClosed).toBe(1)
    expect(room.open).toBe(false)
    client.close()
    expect(clientClosed).toBe(1)
  })

  it('delivers nothing after a close, even if it was already on its way', async () => {
    const [room, client] = loopback<Out, In>()
    const got: string[] = []
    client.onMessage = (m) => got.push(m.t)
    room.send({ t: 'lobby' })
    client.close()
    await settle()
    expect(got).toEqual([])
  })
})

// ---------------------------------------------------------------------------

type Settings = { mode: number }
interface Held {
  chairs: number[]
  name: string
}
const blank: Held = { chairs: [], name: '?' }

describe('the connections, for a room hosted in this process', () => {
  it('defers to the lobby for who is here', () => {
    // Asked rather than kept: Steam's own answer to who is present is the one
    // worth believing, and it changes without this being told.
    let members: string[] = ['a']
    const f = steam()
    const { peers } = steamPeers<Held>({ steam: f.s, members: () => members })
    expect(peers.all()).toEqual(['a'])
    members = ['a', 'b']
    expect(peers.all()).toEqual(['a', 'b'])
  })

  it('keeps what each connection holds, and forgets it on the way out', () => {
    const f = steam()
    const { peers, forget } = steamPeers<Held>({ steam: f.s, members: () => ['a'] })
    expect(peers.attachment('a')).toBeNull()
    peers.attach('a', { chairs: [0], name: 'Alice' })
    expect(peers.attachment('a')).toEqual({ chairs: [0], name: 'Alice' })
    forget('a')
    expect(peers.attachment('a')).toBeNull()
    expect(f.closed).toEqual(['a'])
  })

  it('routes a droppable message to the hot channel and everything else to the careful one', () => {
    const f = steam()
    const { peers } = steamPeers<Held>({ steam: f.s, members: () => ['a'] })
    peers.send('a', '{"t":"in"}', true)
    peers.send('a', '{"t":"lobby"}')
    expect(f.sent.map((x) => [x.channel, x.reliable])).toEqual([
      [INPUT, false],
      [CONTROL, true],
    ])
  })

  it('hands each message over with who sent it', () => {
    const f = steam()
    const { pump } = steamPeers<Held>({ steam: f.s, members: () => ['a', 'b'] })
    const got: [string, unknown][] = []
    f.put(INPUT, 'b', { t: 'in', n: 3 })
    f.put(CONTROL, 'a', { t: 'startReq' })
    pump((from, msg) => got.push([from, msg]))
    expect(got).toEqual([
      ['a', { t: 'startReq' }],
      ['b', { t: 'in', n: 3 }],
    ])
  })

  it('sends to its own client without going near Steam', async () => {
    // The listen host is a player as well as a room, so it is in its own member
    // list — and a broadcast that reached for the wire to talk to itself would be
    // asking Steam to deliver a message to the machine it is running on. Its own
    // end is the loopback instead, which is also what keeps the host off a
    // special-cased path: it hears the lobby the same way and at the same point
    // everybody else does.
    const f = steam()
    const [mine, ours] = loopback<Out, In>()
    const heard: string[] = []
    ours.onMessage = (m) => heard.push(m.t)
    const { peers } = steamPeers<Held>({
      steam: f.s,
      members: () => ['me', 'a'],
      self: { id: 'me', send: (payload) => mine.send(JSON.parse(payload) as Out) },
    })
    const host = new Host<string, Settings, number, Held>({
      peers,
      blank,
      say: () => {},
    })
    host.broadcast({ t: 'lobby' })
    await settle()
    expect(heard).toEqual(['lobby'])
    // And exactly one thing went out on the wire: the other peer's copy.
    expect(f.sent.map((x) => x.to)).toEqual(['a'])
  })
})

describe('a listen host, end to end', () => {
  it('tells its own client about the room through the same path as everybody else', async () => {
    // The property the whole arrangement exists for. If the host reached into its
    // own room directly it would be a special case in every path that touches the
    // network, and the least-exercised case would be the one nobody else is on.
    const members: Member<string, number>[] = []
    const room = new Room<string, Settings, number>({
      capacity: 6,
      roster: 6,
      clock: rollbackClock({ window: 14, slack: 4 }),
      silenceMs: 4000,
      recall: 64,
      heartbeatMs: 45_000,
      settings: { mode: 0 },
      checkSettings: () => ({ mode: 0 }),
      checkSeat: (raw) => (raw === 0 || raw === 1 ? (raw as number) : null),
      members: () => members,
    })

    const f = steam()
    const [mine, ours] = loopback<Out, In>()
    const seen: string[] = []
    ours.onMessage = (m) => seen.push(m.t)

    const { peers } = steamPeers<Held>({
      steam: f.s,
      members: () => members.map((m) => m.who),
      self: { id: 'me', send: (payload) => mine.send(JSON.parse(payload) as Out) },
    })
    const host: Host<string, Settings, number, Held> = new Host({
      peers,
      blank,
      // The game's own words, which is all a game has to write.
      say: (d: Decision<string, Settings, number>) => {
        if (d.kind === 'seated') {
          members.push({ who: d.who, chairs: [...d.chairs], name: d.who, seats: [], players: [] })
        }
        if (d.kind === 'lobby') host.broadcast({ t: 'lobby' })
      },
    })

    host.carry(room.arrive('me', { name: 'me', build: 'v1', announce: false, code: 'ABCD' }, 0))
    host.carry(room.arrived('me', 'me', 0))
    await settle()
    expect(seen).toEqual(['lobby'])
    // Nothing went to Steam: the only member is the host itself.
    expect(f.sent).toEqual([])
  })
})
