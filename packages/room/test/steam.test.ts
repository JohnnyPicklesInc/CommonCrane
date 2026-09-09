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
  openLobby,
  publish,
  browse,
  invitedTo,
  type Messages,
  type Received,
  type Lobbies,
} from '../src/steam.ts'
import type { Listed } from '../src/listing.ts'
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

// ---------------------------------------------------------------------------

/** Steam's lobby half, as a Map and a call log. */
function lobbies(seed: Record<string, Record<string, string>> = {}) {
  const store = new Map<string, Record<string, string>>(Object.entries(seed))
  const calls: string[] = []
  const joinable = new Map<string, boolean>()
  let breakList = false
  let unreadable: string | null = null
  let next = 100
  const l: Lobbies = {
    create: async (max) => {
      const id = String(next++)
      calls.push(`create(${max})->${id}`)
      store.set(id, {})
      return id
    },
    join: async (lobby) => void calls.push(`join(${lobby})`),
    leave: async (lobby) => void calls.push(`leave(${lobby})`),
    list: async () => {
      if (breakList) throw new Error('steam is having a moment')
      return [...store.keys()]
    },
    data: async (lobby) => {
      if (lobby === unreadable) throw new Error('gone')
      return store.get(lobby) ?? {}
    },
    setData: async (lobby, data) => {
      calls.push(`setData(${lobby},${Object.keys(data).sort().join('+')})`)
      store.set(lobby, { ...(store.get(lobby) ?? {}), ...data })
    },
    members: async () => [],
    owner: async () => 'me',
    joinable: async (lobby, on) => {
      calls.push(`joinable(${lobby},${on})`)
      joinable.set(lobby, on)
    },
    invite: async (lobby) => void calls.push(`invite(${lobby})`),
  }
  return {
    l,
    calls,
    store,
    joinable,
    breakTheList: () => {
      breakList = true
    },
    makeUnreadable: (id: string) => {
      unreadable = id
    },
  }
}

/** What `publish` would have written for a room like this. */
const room = (over: Partial<Listed> = {}): Listed => ({
  code: 'ignored',
  host: 'Alice',
  players: 2,
  max: 6,
  since: 1000,
  live: false,
  build: 'v1',
  updated: 0,
  ...over,
})

describe('opening a room on Steam', () => {
  it('stamps the build before anybody can find it', async () => {
    // The order is the point. A lobby that is listed before it says what it
    // plays is one other builds offer to their players for as long as it takes
    // the next call to land — and every one of them is turned away at the door.
    const f = lobbies()
    const id = await openLobby(f.l, { build: 'v1', max: 6, announce: true })
    expect(f.calls).toEqual([`create(6)->${id}`, `setData(${id},r.build)`, `joinable(${id},true)`])
  })

  it('is private unless asked otherwise', async () => {
    // Being listed when you did not ask is worse than not being listed when you
    // did, and the room says which it is through a `listed` decision anyway.
    const f = lobbies()
    const id = await openLobby(f.l, { build: 'v1', max: 6 })
    expect(f.joinable.get(id)).toBe(false)
  })
})

describe('answering a listed decision', () => {
  it('writes the card and turns the browsing on together', async () => {
    // A lobby left joinable with nothing in its data is a card with no writing
    // on it.
    const f = lobbies({ '7': {} })
    await publish(f.l, '7', room({ players: 3, live: true }))
    expect(f.joinable.get('7')).toBe(true)
    expect(f.store.get('7')).toMatchObject({
      'r.build': 'v1',
      'r.host': 'Alice',
      'r.players': '3',
      'r.max': '6',
      'r.since': '1000',
      'r.live': '1',
    })
  })

  it('takes the room off the list without turning anybody out of it', async () => {
    // Coming off the board is not leaving the lobby: the people in it are still
    // playing and an invited friend can still be let in. Only browsing stops.
    const f = lobbies({ '7': {} })
    await publish(f.l, '7', null)
    expect(f.joinable.get('7')).toBe(false)
    expect(f.calls.some((c) => c.startsWith('leave'))).toBe(false)
  })

  it('writes nothing for an `about` the game did not set', async () => {
    // An empty key is still a key, and a reader cannot tell "said nothing" from
    // "said undefined".
    const f = lobbies({ '7': {} })
    await publish(f.l, '7', room())
    expect('r.about' in f.store.get('7')!).toBe(false)
  })
})

describe('browsing for a room', () => {
  it('offers only rooms on this exact build', async () => {
    // Not politeness: a room seats only clients running its own bundle, so an
    // entry on another build is a dead link that looks like a game. On Steam
    // that is a stale depot, which is likelier than a stale tab — Steam updates
    // in the background and a running game does not.
    const f = lobbies()
    await publish(f.l, await openLobby(f.l, { build: 'v1', max: 6 }), room())
    await publish(f.l, await openLobby(f.l, { build: 'v2', max: 6 }), room({ build: 'v2' }))
    const offers = await browse(f.l, { build: 'v1', now: 5000 })
    expect(offers.length).toBe(1)
  })

  it('hands back something directly joinable', async () => {
    // The lobby id doubles as the code, so a click on an offer is a join rather
    // than a lookup that turns a code into a lobby.
    const f = lobbies()
    const id = await openLobby(f.l, { build: 'v1', max: 6 })
    await publish(f.l, id, room())
    const [offer] = await browse(f.l, { build: 'v1', now: 5000 })
    expect(offer?.code).toBe(id)
    await f.l.join(offer!.code)
    expect(f.calls).toContain(`join(${id})`)
  })

  it('skips a lobby that has not said what it is', async () => {
    // Either something else entirely, or one caught between being created and
    // being stamped. Neither is joinable and guessing gains nothing.
    const f = lobbies({ '900': {}, '901': { unrelated: 'yes' } })
    expect(await browse(f.l, { build: 'v1', now: 5000 })).toEqual([])
  })

  it('shows the newest room first', async () => {
    const f = lobbies()
    const old = await openLobby(f.l, { build: 'v1', max: 6 })
    await publish(f.l, old, room({ since: 100, host: 'Old' }))
    const recent = await openLobby(f.l, { build: 'v1', max: 6 })
    await publish(f.l, recent, room({ since: 900, host: 'New' }))
    const offers = await browse(f.l, { build: 'v1', now: 5000 })
    expect(offers.map((o) => o.host)).toEqual(['New', 'Old'])
  })

  it('carries whatever the game put on the card', async () => {
    const f = lobbies()
    const id = await openLobby(f.l, { build: 'v1', max: 6 })
    await publish(f.l, id, room({ about: { arena: 'pond', matchup: [3, 7] } }))
    const [offer] = await browse(f.l, { build: 'v1', now: 5000 })
    expect(offer?.about).toEqual({ arena: 'pond', matchup: [3, 7] })
  })

  it('reads as no games rather than as an error when Steam will not answer', async () => {
    // Polled on a timer behind a menu somebody is looking at. A blip should not
    // stack an error over the buttons every few seconds.
    const f = lobbies()
    f.breakTheList()
    expect(await browse(f.l, { build: 'v1', now: 5000 })).toEqual([])
  })

  it('does not lose the whole list to one unreadable lobby', async () => {
    const f = lobbies()
    const good = await openLobby(f.l, { build: 'v1', max: 6 })
    await publish(f.l, good, room())
    const bad = await openLobby(f.l, { build: 'v1', max: 6 })
    await publish(f.l, bad, room())
    f.makeUnreadable(bad)
    const offers = await browse(f.l, { build: 'v1', now: 5000 })
    expect(offers.map((o) => o.code)).toEqual([good])
  })

  it('survives a card with junk written on it', async () => {
    // Written by a build that words it differently, which is exactly the case
    // the build filter exists for — but it has to be read before it can be
    // filtered.
    const f = lobbies({
      '900': { 'r.build': 'v1', 'r.players': 'lots', 'r.since': 'yesterday', 'r.about': '{oh dear' },
    })
    const [offer] = await browse(f.l, { build: 'v1', now: 5000 })
    expect(offer?.players).toBe(0)
    expect(offer?.since).toBe(5000)
    expect(offer?.about).toBeUndefined()
  })
})

describe('an invite accepted before the game was running', () => {
  it('reads the lobby off the command line', () => {
    expect(invitedTo(['game.exe', '+connect_lobby', '109775241004797650'])).toBe(
      '109775241004797650',
    )
  })

  it('is nothing when there was no invite', () => {
    expect(invitedTo(['game.exe'])).toBeNull()
    expect(invitedTo(['game.exe', '+connect_lobby'])).toBeNull()
  })

  it('takes digits and nothing else', () => {
    // Somebody else's text arriving on a command line, and everything downstream
    // treats it as an identity.
    expect(invitedTo(['game.exe', '+connect_lobby', '../../etc/passwd'])).toBeNull()
    expect(invitedTo(['game.exe', '+connect_lobby', '12; rm -rf /'])).toBeNull()
    expect(invitedTo(['game.exe', '+connect_lobby', ''])).toBeNull()
  })
})
