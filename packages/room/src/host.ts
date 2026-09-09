// The part of a host that is the same on every host.
//
// `durable.ts` is this for one runtime, and everything in it that was actually
// about Cloudflare turned out to be three type names. What is left over — read
// what a connection holds, change one field of it, send to one, send to all but
// one, and look at the room again no later than some deadline — is what every
// game in this family writes again for whatever it happens to be running on.
// A peer-hosted game needs the identical five things with a Steam identity where
// the socket was.
//
// So: the same seam the rest of the library draws, one layer further out. `Room`
// decides, this carries, and the game words it.
//
// Two things it deliberately does not own, and both are refusals rather than
// omissions:
//
// **Membership.** `Peers` is asked, never kept. A room can lose its memory while
// its connections outlive it, so on a host like a Durable Object the runtime's
// socket list and the attachments hanging off it are the only record that
// survives — a copy in here would be a second answer to the same question, and
// stale the moment the object is replaced. This is the argument `Room` already
// makes about `members()`, and it does not stop being true out here.
//
// **The wire.** Of the sixteen decisions a room can hand back, exactly four are
// about being a host: write this down, look again later, put the room on the
// board, throw it away. The other twelve are things to tell people, and what to
// say is the game's vocabulary — six games, six protocols, and no prospect of a
// seventeenth that suits them all. Those go to `say`.

import type { Decision } from './room.ts'
import type { LobbyState } from './lobby.ts'
import type { Listed } from './listing.ts'

/**
 * The connections, as a host needs to see them.
 *
 * Four operations, and a host on any runtime can supply them in about thirty
 * lines. `Who` is the caller's own handle — a socket, a Steam identity, an id —
 * and is only ever passed back out.
 */
export interface Peers<Who, Held> {
  /** Everybody connected, right now. Asked on every broadcast, never cached. */
  all(): readonly Who[]
  /**
   * What this connection holds, or null for one that holds nothing yet.
   *
   * Null rather than an error: a connection the runtime has only just accepted
   * has nothing on it, and treating that as a fault means a `catch` at every
   * call site instead of an empty record here.
   */
  attachment(who: Who): Held | null
  attach(who: Who, held: Held): void
  /**
   * Send an already-serialised payload.
   *
   * Serialised by the caller rather than here, because a broadcast is the hot
   * path: six players at sixty a second is what this carries, and stringifying
   * the same message once per recipient is the one wasteful thing at that rate
   * that is easy to avoid. An implementation moves bytes and nothing else.
   *
   * `unreliable` is permission to drop this one rather than an instruction to.
   * A host with one ordered stream — a WebSocket — ignores it and is right to;
   * one with a choice sends it where a late copy is worse than no copy. Only the
   * caller can say: an input echo carries a run of recent frames and heals
   * itself, and everything else a room says is news that cannot be missed.
   */
  send(who: Who, payload: string, unreliable?: boolean): void
}

/** How to send one message, when it is not simply "to everybody, reliably". */
export interface Delivery<Who = never> {
  /** Spare this one. Whoever the news is about rarely needs telling. */
  readonly except?: Who
  /** This one may be dropped — see `Peers.send`. */
  readonly unreliable?: boolean
}

export interface HostOptions<Who, Settings, Seat, Held> {
  readonly peers: Peers<Who, Held>
  /**
   * What a connection holds before anything has been put on it.
   *
   * The shape is the game's entirely and is deliberately not constrained. An
   * attachment can outlive a deploy — sockets stay connected while the object
   * behind them is replaced — so a library insisting on its own field names
   * would rename the contents of every room that happened to be occupied.
   */
  readonly blank: Held
  /** Write the lobby down. A room can lose its memory with people still in it. */
  readonly save?: (state: LobbyState<Settings>, started: boolean) => void
  /** Look at this room again in this many milliseconds, or null to stop. */
  readonly wake?: (inMs: number | null) => void
  /** Put the room on the public list under these terms, or take it off. */
  readonly list?: (entry: Listed | null, code: string) => void
  /** Everybody has gone. Throw the room away so its code can be used again. */
  readonly recycle?: () => void
  /**
   * The game's own words for everything this does not own.
   *
   * `from` is whoever caused the decision, when there was somebody — passed
   * through so a game can spare them a broadcast of their own news.
   */
  readonly say: (d: Decision<Who, Settings, Seat>, from?: Who) => void
}

export class Host<Who, Settings, Seat, Held> {
  private readonly opts: HostOptions<Who, Settings, Seat, Held>

  constructor(opts: HostOptions<Who, Settings, Seat, Held>) {
    this.opts = opts
  }

  /** What this connection holds. Empty rather than null on a fresh one. */
  held(who: Who): Held {
    return this.opts.peers.attachment(who) ?? this.opts.blank
  }

  /**
   * Change part of what a connection holds, leaving the rest standing.
   *
   * The read and the merge belong together. Six places in one game were
   * spreading the old attachment over a new one by hand, and an attachment is
   * the only record of who somebody is in a room — spread one field short and a
   * person loses their name, their chairs or the place they are driving,
   * silently, with the type checker perfectly happy because every field is still
   * present.
   */
  hold(who: Who, patch: Partial<Held>): Held {
    const next = { ...this.held(who), ...patch }
    this.opts.peers.attach(who, next)
    return next
  }

  /**
   * Send to one, and never mind if it has gone.
   *
   * A connection can die between being chosen and being written to, and there
   * is nothing useful to do about it here: the close handler is already on its
   * way. Throwing instead takes the whole message handler down, which loses the
   * other nine people's copy of whatever it was.
   */
  sendTo(who: Who, msg: unknown, how: Delivery = {}): void {
    const payload = JSON.stringify(msg)
    try {
      this.opts.peers.send(who, payload, how.unreliable)
    } catch {
      // Gone between selection and send.
    }
  }

  /** Send to everybody, optionally sparing one. Serialised once. */
  broadcast(msg: unknown, how: Delivery<Who> = {}): void {
    const payload = JSON.stringify(msg)
    for (const who of this.opts.peers.all()) {
      if (how.except !== undefined && who === how.except) continue
      try {
        this.opts.peers.send(who, payload, how.unreliable)
      } catch {
        // As above.
      }
    }
  }

  /**
   * Carry out what the room decided.
   *
   * The four host-shaped decisions are handled here; everything else is handed
   * to the game with `from` carried through. A game that wants to do something
   * of its own on one of these four can watch for it in `say` as well — they are
   * passed on afterwards rather than swallowed, because a game may well want to
   * know that its room has just been listed or recycled.
   */
  carry(out: readonly Decision<Who, Settings, Seat>[], from?: Who): void {
    for (const d of out) this.act(d, from)
  }

  private act(d: Decision<Who, Settings, Seat>, from?: Who): void {
    switch (d.kind) {
      case 'remember':
        this.opts.save?.(d.state, d.started)
        break
      case 'wake':
        this.opts.wake?.(d.inMs)
        break
      case 'listed':
        this.opts.list?.(d.entry, d.code)
        break
      case 'recycle':
        this.opts.recycle?.()
        break
      default:
        break
    }
    this.opts.say(d, from)
  }
}

/**
 * A heartbeat over plain timers, for a host that stays in memory.
 *
 * The counterpart of `beat` in `durable.ts`, which does this against a Durable
 * Object alarm. "No later than" is the whole of it, and it took a bug to get
 * right: a room changes how often it wants looking at — rarely while it is a
 * lobby, often once a match is running — and a pending lobby-length wake
 * swallowed every request for a shorter one. The room went on being looked at
 * once a minute for the whole match, and nobody was ever noticed going quiet.
 *
 * So a pending wake later than the one asked for is brought forward, and one
 * already sooner is left alone.
 */
export function heartbeat(look: () => void): {
  wake: (inMs: number | null) => void
  stop: () => void
} {
  let handle: ReturnType<typeof setTimeout> | null = null
  let due = Infinity
  const clear = (): void => {
    if (handle !== null) clearTimeout(handle)
    handle = null
    due = Infinity
  }
  return {
    wake(inMs: number | null): void {
      if (inMs === null) {
        clear()
        return
      }
      const at = Date.now() + inMs
      if (handle !== null && due <= at) return
      if (handle !== null) clearTimeout(handle)
      due = at
      handle = setTimeout(() => {
        handle = null
        due = Infinity
        look()
      }, inMs)
    },
    stop: clear,
  }
}
