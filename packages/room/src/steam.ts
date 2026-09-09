// Getting to a room over Steam.
//
// The counterpart of `client.ts`, which does this over a WebSocket, and it is
// deliberately the same shape: a `Transport` is a `Transport`, so the game above
// it does not learn a second way to be online. `session.ts` in the game this was
// taken from never knew what a socket was and does not need to start.
//
// What is different is underneath. `ISteamNetworkingMessages` has no receive
// callback — you ask it whether anything has arrived — so somebody has to poll,
// and that somebody is the caller: see `pump`. And it has real channels, so the
// hot path and the careful path travel separately instead of being told apart by
// reading the message.
//
// Nothing here imports a Steam SDK, and nothing here can. `Messages` is the four
// operations this needs, and a host supplies them from whatever it is actually
// running against — a Rust sidecar over the `steamworks` crate, in the case this
// was written for. Which is what keeps the module dependency-free, testable at
// full speed against a fake, and safe to have in a browser bundle that will
// never call it.

import type { Peers } from './host.ts'
import type { Transport } from './client.ts'
import { sift, type Listed, type Offer } from './listing.ts'

// Re-exported so a game on Steam needs one entry point rather than two. The type
// is erased, so this costs nothing and drags no browser globals in behind it.
export type { Transport } from './client.ts'

/**
 * A Steam identity, as decimal digits.
 *
 * A string rather than a number, and this is not fastidiousness: a steamID64 is
 * around 7.6e16, and `Number.MAX_SAFE_INTEGER` is 9.0e15. Every Steam id in
 * existence is too big to be a JavaScript number, so one carried as a number is
 * silently the wrong person. JSON has no bigint either, and these travel as JSON
 * to reach the process holding the SDK, so digits it is.
 */
export type Id = string

/** Something that arrived, and who from. */
export interface Received {
  readonly from: Id
  readonly payload: string
}

/**
 * The messaging half of Steam, as this needs to see it.
 *
 * Four operations. Deliberately not the lobby half — a transport has no business
 * knowing how a room was found, and an interface wider than its user is the
 * thing this library keeps refusing to write.
 */
export interface Messages {
  /** Who we are. */
  me(): Id
  /**
   * Send, returning whether Steam took it.
   *
   * False is not "the peer did not get it" — nothing here can know that. It is
   * "Steam would not accept this", which in practice means over the size limit,
   * and that is worth hearing about rather than dropping: see `onRefused`.
   */
  send(to: Id, payload: string, channel: number, reliable: boolean): boolean
  /** Whatever has arrived on this channel, up to `max`, oldest first. */
  drain(channel: number, max: number): readonly Received[]
  /** Let somebody talk to us. Nothing flows until this is called. */
  accept(who: Id): void
  /** Done with them. */
  close(who: Id): void
}

/**
 * The careful channel: everything that is not input.
 *
 * Reliable and ordered. A lobby view, a handover, a catchup — losing any of them
 * is not a dropped frame, it is a client playing a different game or a room
 * nobody can see.
 */
export const CONTROL = 0

/**
 * The hot channel: input, sixty times a second.
 *
 * Unreliable on purpose. Every message carries a run of recent frames, so a lost
 * one is filled by the next — and waiting for a retransmission of a frame that
 * has already been superseded is worse than never having it.
 */
export const INPUT = 1

/** How many messages to take off a channel per pump. */
const BATCH = 64

export interface SteamTransportOptions<Out> {
  readonly steam: Messages
  /** The room. On Steam that is a peer: whoever is hosting. */
  readonly to: Id
  /**
   * Which of your messages may be dropped.
   *
   * The library cannot tell: one game's hot path is a packed input frame and
   * another's is a cursor position, and neither is anything this can read. Left
   * out, everything is sent reliably, which is the answer that is merely slow
   * rather than wrong.
   */
  readonly unreliable?: (msg: Out) => boolean
  /**
   * Steam would not take a message.
   *
   * Worth a hook rather than a silent drop, because the way this fails is by
   * size: the interface caps a message well below what a whole match log comes
   * to, so the thing that goes missing is a catchup, and a catchup that vanishes
   * leaves somebody watching a game they can never join. This is also where
   * splitting one up will go when it is needed.
   */
  readonly onRefused?: (msg: Out) => void
  readonly batch?: number
}

/**
 * A room reached over Steam.
 *
 * One peer, like `WsTransport`: this is the client end. A host does not use one
 * of these at all — it has many peers and a `Room`, which is what `steamPeers`
 * and `Host` are for.
 *
 * **Exactly one thing in a process may drain a channel.** Two drainers steal
 * from each other, silently, and what goes missing is half of everybody's input.
 * On a joiner this is the drainer; on a host it is the peer pump, and the host's
 * own client reaches its room through `loopback` rather than through Steam at
 * all — which is what keeps that rule true without anybody having to think about
 * it.
 */
export class SteamTransport<Out, In> implements Transport<Out, In> {
  private readonly opts: SteamTransportOptions<Out>
  private live = true
  private closed = false
  onMessage: (msg: In) => void = () => {}
  onClose: () => void = () => {}

  constructor(opts: SteamTransportOptions<Out>) {
    this.opts = opts
    // Nothing flows until both ends have accepted, and the far end cannot ask
    // until it has heard from us. Accepting whoever we are about to talk to
    // costs nothing and removes an ordering question.
    this.opts.steam.accept(opts.to)
  }

  get open(): boolean {
    return this.live
  }

  send(msg: Out): void {
    if (!this.live) return
    const reliable = this.opts.unreliable?.(msg) !== true
    const ok = this.opts.steam.send(
      this.opts.to,
      JSON.stringify(msg),
      reliable ? CONTROL : INPUT,
      reliable,
    )
    if (!ok) this.opts.onRefused?.(msg)
  }

  /**
   * Take whatever has arrived and hand it up.
   *
   * The caller's to call, and not on a timer of this library's, for two reasons.
   * A game already has a loop running at the rate this wants; a second timer
   * beside it is a second clock to be wrong about. And how promptly this is
   * called *is* the inbound latency, which makes it a decision worth leaving
   * where somebody can see it rather than burying a default in here.
   *
   * Messages from anybody but the room are dropped. A client has one peer, and
   * anything else arriving is either a stale session from a match that ended or
   * somebody who should not be talking to us.
   */
  pump(): void {
    if (!this.live) return
    const max = this.opts.batch ?? BATCH
    for (const channel of [CONTROL, INPUT]) {
      for (const got of this.opts.steam.drain(channel, max)) {
        if (got.from !== this.opts.to) continue
        const msg = parse<In>(got.payload)
        // A malformed frame is not worth tearing the match down over.
        if (msg !== null) this.onMessage(msg)
      }
    }
  }

  /**
   * Give up on this room.
   *
   * Also the way a caller reports a session that failed: there is no connection
   * state on this interface, so a peer going unreachable arrives as a callback
   * from the SDK and this is what to do about it. `onClose` fires once however
   * many times this is called, because a game that tears a match down twice
   * tears down the one it started afterwards.
   */
  close(): void {
    this.live = false
    if (this.closed) return
    this.closed = true
    this.opts.steam.close(this.opts.to)
    this.onClose()
  }
}

function parse<T>(payload: string): T | null {
  try {
    return JSON.parse(payload) as T
  } catch {
    return null
  }
}

/**
 * The two ends of a room and a client in the same process.
 *
 * A listen host is a player as well as a room, and the tempting thing is to let
 * its client call the room directly. That way the host is a special case in every
 * path that touches the network, and the case that gets exercised least is the
 * one everybody else is on.
 *
 * So instead the host plays through a `Transport` like everybody else, and this
 * is that transport with no wire under it.
 *
 * Delivery is deferred, and that is the whole substance of this function. A real
 * socket never calls you back inside your own `send`, and a room in the middle of
 * carrying out a list of decisions is not re-entrant — an inline delivery lets
 * the client answer a `lobby` before the `begun` after it has been sent, which is
 * an ordering no remote peer could ever produce and no test would ever find.
 * `queueMicrotask` rather than a timer: this is about ordering, not about time.
 */
export function loopback<A, B>(): [Transport<A, B>, Transport<B, A>] {
  const end = <Out, In>(): Transport<Out, In> & { deliver: (msg: In) => void } => {
    let live = true
    let closed = false
    const t = {
      onMessage: (_msg: In) => {},
      onClose: () => {},
      get open() {
        return live
      },
      send: (_msg: Out) => {},
      close: () => {
        live = false
        if (closed) return
        closed = true
        t.onClose()
      },
      deliver: (msg: In) => {
        if (!live) return
        queueMicrotask(() => {
          if (live) t.onMessage(msg)
        })
      },
    }
    return t
  }
  const a = end<A, B>()
  const b = end<B, A>()
  a.send = (msg: A) => b.deliver(msg)
  b.send = (msg: B) => a.deliver(msg)
  // Closing one end closes the other, as losing a socket does. Guarded on both
  // sides against the recursion that makes obvious.
  const both = (x: Transport<never, never>, y: { close: () => void }) => {
    const own = x.close.bind(x)
    return () => {
      if (!x.open) return
      own()
      y.close()
    }
  }
  const ac = both(a as unknown as Transport<never, never>, b)
  const bc = both(b as unknown as Transport<never, never>, a)
  a.close = ac
  b.close = bc
  return [a, b]
}

export interface SteamPeersOptions {
  readonly steam: Messages
  /**
   * Everybody in the room right now.
   *
   * Asked rather than kept, like `Room.members` — but for a different reason,
   * and it is worth being clear which. `durable` cannot keep a membership list
   * because its connections outlive its memory. Here they do not: the room is
   * inside this process, so if this process goes there is no room left to hold a
   * stale list. What this defers to instead is the lobby, which is Steam's own
   * answer to who is present and is therefore the one worth believing.
   */
  readonly members: () => readonly Id[]
  /**
   * This machine's own client, which is not on the wire.
   *
   * A listen host is a player as well as a room, so it appears in its own member
   * list — and a broadcast that reached for Steam to talk to itself would be
   * asking Valve to deliver a message to the machine it is running on. Given an
   * end here, its own copy goes down that instead.
   *
   * Left out for a host that is only a room and not also a player, which is what
   * a dedicated one is.
   */
  readonly self?: {
    readonly id: Id
    /** Hand it to the client at the other end of a `loopback` pair. */
    readonly send: (payload: string) => void
  }
  readonly batch?: number
}

/**
 * The connections, for a room hosted in this process.
 *
 * `Peers` for `Host`, over Steam identities, plus the pump that feeds it. The
 * attachments are kept here — see the note on `members` for why that is safe
 * here and is not on a Durable Object.
 */
export function steamPeers<Held>(opts: SteamPeersOptions): {
  readonly peers: Peers<Id, Held>
  /**
   * Take whatever has arrived and hand each one over, with who sent it.
   *
   * The host's half of the rule in `SteamTransport`: this is the only thing in
   * the process that may drain. The caller drives it, for the same reasons.
   */
  pump(deliver: (from: Id, msg: unknown) => void): void
  /** Forget what somebody held. For a peer who has left for good. */
  forget(who: Id): void
} {
  const attachments = new Map<Id, Held>()
  return {
    peers: {
      all: () => opts.members(),
      attachment: (who) => attachments.get(who) ?? null,
      attach: (who, held) => {
        attachments.set(who, held)
      },
      send: (who, payload, unreliable) => {
        // Our own client first: it is a member like any other and must not be
        // sent to over the network — see `self`.
        if (opts.self !== undefined && who === opts.self.id) {
          opts.self.send(payload)
          return
        }
        // Where the two channels are actually chosen between. Everything a room
        // says is news that cannot be missed; the exception is the input echo a
        // game relays on the hot path, which heals itself and asks to be
        // droppable. The caller says which it is — this only routes it.
        if (unreliable === true) opts.steam.send(who, payload, INPUT, false)
        else opts.steam.send(who, payload, CONTROL, true)
      },
    },
    pump(deliver) {
      const max = opts.batch ?? BATCH
      for (const channel of [CONTROL, INPUT]) {
        for (const got of opts.steam.drain(channel, max)) {
          const msg = parse<unknown>(got.payload)
          if (msg !== null) deliver(got.from, msg)
        }
      }
    },
    forget(who) {
      attachments.delete(who)
      opts.steam.close(who)
    },
  }
}

// ---------------------------------------------------------------------------
// Finding a room, and being found.
//
// `client.ts` does this against your own HTTP endpoints: mint a code, ask a
// directory what is public, read an invite out of the address bar. Steam already
// has all three, so this is the same four jobs against Valve's versions of them.
//
// One difference is worth stating because it removes machinery rather than adding
// it. A directory of our own is a *cache* of something the rooms own: a room that
// crashes leaves an entry nobody can retract, which is why `Listed` carries the
// time it was last confirmed and why `sift` throws away anything stale. Steam's
// lobby list is not a cache. Valve removes a lobby when its owner goes, so
// nothing here can be stale and the whole staleness half of `sift` is inert.
//
// What is emphatically not inert is the build filter. A room seats only clients
// running its own bundle — `Room` refuses the rest at the door — so a lobby on
// another build is not a game somebody can join, it is a dead link that looks
// like one. On Steam that means a stale depot rather than a stale tab, which is
// if anything more likely: Steam updates in the background and a running game
// does not.

/**
 * A Steam lobby's id, as decimal digits.
 *
 * The same shape as an `Id` and a different thing, so it is named separately.
 * Both are u64 and both are too large to be a JavaScript number — see `Id`.
 *
 * On Steam this is also the room's *code*. A four-character code exists so it
 * can be read aloud down a telephone, and Steam invites are a button in the
 * overlay rather than something anybody types — so `makeCode` has no job here,
 * and using the lobby id means an offer somebody clicks in a list is directly
 * joinable instead of needing a second lookup to turn a code into a lobby.
 */
export type LobbyId = string

/**
 * The lobby half of Steam, as this needs to see it.
 *
 * Asynchronous throughout, unlike `Messages`. Nothing here is on a hot path —
 * it is menus, and once at the start of a match — so there is no reason to make
 * a host pretend a request to another process is instant. `Messages` is sync
 * because inbound frames can be queued locally and drained; a lobby list cannot.
 */
export interface Lobbies {
  /** Open one, and get its id. On Steam this is the room coming into existence. */
  create(max: number): Promise<LobbyId>
  join(lobby: LobbyId): Promise<void>
  leave(lobby: LobbyId): Promise<void>
  /**
   * Every lobby for this app that is currently joinable.
   *
   * No filter, because Steam's own list call takes none: what a lobby is *for*
   * is in its data, and that has to be read before it can be judged. So the
   * filtering happens here, on the way out — see `browse`.
   */
  list(): Promise<readonly LobbyId[]>
  data(lobby: LobbyId): Promise<Record<string, string>>
  setData(lobby: LobbyId, data: Record<string, string>): Promise<void>
  members(lobby: LobbyId): Promise<readonly Id[]>
  owner(lobby: LobbyId): Promise<Id>
  /** Whether Steam offers this lobby to anybody else. */
  joinable(lobby: LobbyId, on: boolean): Promise<void>
  /** Steam's invite overlay, in place of a link to copy. */
  invite(lobby: LobbyId): Promise<void>
}

/**
 * The keys a room's listing is written under.
 *
 * One definition, used by whoever writes and whoever reads, because the failure
 * mode of two is silent: a writer and a reader that disagree about a key produce
 * a lobby that lists as somebody else's build, or with no host name, and the
 * room looks empty rather than broken.
 *
 * Prefixed, because lobby data is a single flat namespace shared with anything
 * else a game keeps in there.
 */
const KEY = {
  build: 'r.build',
  host: 'r.host',
  players: 'r.players',
  max: 'r.max',
  since: 'r.since',
  live: 'r.live',
  about: 'r.about',
} as const

/**
 * Open a room on Steam.
 *
 * The counterpart of `createRoom`, and it does one thing more: it stamps the
 * build in before the lobby is joinable. A lobby that is listed before it says
 * what it plays is one that other builds will offer to their players for as long
 * as it takes the second call to land, and every one of them is turned away at
 * the door.
 *
 * `max` is chairs, so it is the room's capacity rather than its roster.
 */
export async function openLobby(
  lobbies: Lobbies,
  opts: { readonly build: string; readonly max: number; readonly announce?: boolean },
): Promise<LobbyId> {
  const lobby = await lobbies.create(opts.max)
  await lobbies.setData(lobby, { [KEY.build]: opts.build })
  // Not joinable until somebody says so. A private room is the safer default:
  // being listed when you did not ask is worse than not being listed when you
  // did, and the room says which it is through a `listed` decision anyway.
  await lobbies.joinable(lobby, opts.announce === true)
  return lobby
}

/**
 * Answer a `listed` decision on Steam.
 *
 * Give this to `Host` as its `list`. A room decides whether it belongs on the
 * public board and under what terms; on Steam that is lobby data plus whether
 * Valve offers the lobby to anybody, and the two move together — a lobby left
 * joinable with nothing in its data is a card with no writing on it.
 *
 * `null` is the room asking to come off the list, which is a different thing
 * from leaving the lobby: the people in it are still playing, and an invited
 * friend can still be let in. Only the browsing is switched off.
 */
export async function publish(
  lobbies: Lobbies,
  lobby: LobbyId,
  entry: Listed | null,
): Promise<void> {
  if (entry === null) {
    await lobbies.joinable(lobby, false)
    return
  }
  const data: Record<string, string> = {
    [KEY.build]: entry.build,
    [KEY.host]: entry.host,
    [KEY.players]: String(entry.players),
    [KEY.max]: String(entry.max),
    [KEY.since]: String(entry.since),
    [KEY.live]: entry.live === true ? '1' : '0',
  }
  // Only if there is one: an empty key is still a key, and a reader cannot tell
  // "the game said nothing" from "the game said undefined".
  if (entry.about !== undefined) data[KEY.about] = JSON.stringify(entry.about)
  await lobbies.setData(lobby, data)
  await lobbies.joinable(lobby, true)
}

/** A lobby's data as a `Listed`, or null if it is not one of our rooms at all. */
function listedOf(lobby: LobbyId, data: Record<string, string>, now: number): Listed | null {
  const build = data[KEY.build]
  // No build means either a lobby belonging to something else entirely, or one
  // caught between being created and being stamped. Neither is joinable, and
  // guessing at the difference gains nothing.
  if (build === undefined || build === '') return null
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  let about: unknown
  if (data[KEY.about] !== undefined) {
    try {
      about = JSON.parse(data[KEY.about])
    } catch {
      // Written by a build that words it differently. The card is still worth
      // showing without whatever this was.
    }
  }
  return {
    // The lobby id doubles as the code — see `LobbyId`.
    code: lobby,
    host: data[KEY.host] ?? '?',
    players: num(data[KEY.players], 0),
    max: num(data[KEY.max], 0),
    since: num(data[KEY.since], now),
    live: data[KEY.live] === '1',
    about,
    build,
    // Valve removes a lobby when its owner goes, so anything on the list is
    // confirmed by the fact of being on it. See the note at the top.
    updated: now,
  }
}

/**
 * Rooms waiting for people, on this exact build.
 *
 * The counterpart of `listRooms`, and it hands back the same `Offer[]` — so a
 * game's existing menu goes on working, which is the whole reason this returns
 * somebody else's shape rather than a Steam-flavoured one.
 *
 * Every lobby's data is read, because Steam's list call cannot filter on it.
 * Concurrently, since each is a separate request and a menu is waiting.
 *
 * Returns nothing rather than throwing when the list cannot be had. This is
 * polled on a timer behind a menu somebody is looking at, and a blip should read
 * as "no games right now" rather than stacking an error over the buttons every
 * few seconds — the same judgement `listRooms` makes.
 */
export async function browse(
  lobbies: Lobbies,
  opts: { readonly build: string; readonly now: number },
): Promise<Offer[]> {
  let ids: readonly LobbyId[]
  try {
    ids = await lobbies.list()
  } catch {
    return []
  }
  const found = await Promise.all(
    ids.map(async (id) => {
      try {
        return listedOf(id, await lobbies.data(id), opts.now)
      } catch {
        // One unreadable lobby is not a reason to show an empty list.
        return null
      }
    }),
  )
  const entries: [string, Listed][] = []
  for (const e of found) if (e !== null) entries.push([e.code, e])
  // `sift` for the build filter, the projection and the order, so there is one
  // definition of what a browsing player sees. Its staleness half cannot fire
  // here: every entry was stamped `now` a moment ago, because Steam's list is
  // the truth rather than a cache of it.
  return sift(entries, { build: opts.build, now: opts.now, staleMs: 1 }).offers
}

/**
 * The lobby somebody was invited into, from how the game was launched.
 *
 * The counterpart of `roomFromUrl`. Steam starts the game with `+connect_lobby
 * <id>` when an invite is accepted while the game is closed; accepted while it
 * is already running, the same thing arrives as a callback instead, which is the
 * host's to listen for and to hand to `join`.
 *
 * Read from arguments rather than from the SDK because Steam's own
 * `GetLaunchCommandLine` is not bound in the binding this was written against —
 * and the arguments are where Steam put it either way.
 */
export function invitedTo(argv: readonly string[]): LobbyId | null {
  const at = argv.indexOf('+connect_lobby')
  const raw = at < 0 ? undefined : argv[at + 1]
  // Digits only. This is somebody else's text arriving on a command line, and
  // everything downstream of it treats it as an identity.
  return raw !== undefined && /^[0-9]{1,20}$/.test(raw) ? raw : null
}
