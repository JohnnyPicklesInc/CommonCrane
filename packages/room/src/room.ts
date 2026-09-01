// A whole room, one level up from the parts it is made of.
//
// The same argument that produced `Match`, applied again. Every game in the
// family composed `Lobby`, `Match`, `admit` and `Fingerprints` by hand, and
// every bug that actually happened was in that composition rather than in any
// of the pieces: a room that put itself on the public board because the wrong
// arrival was treated as its opener, a listing left stranded because it was
// taken down after the storage was wiped rather than before, a rematch that
// cleared five of the seven things a match is made of. None of those are
// findable by reading one function.
//
// So this owns the order, and returns what it decided. It has no sockets, no
// storage and no timers — it says a room should be listed, or that somebody
// should be told something, or when it next wants looking at, and the caller
// does it. That is the same seam the rest of the library already draws, and it
// is what keeps the whole thing runnable in a unit test at full speed on any
// host.
//
// Two things it deliberately does not own:
//
// Membership. The connections are the record, because a room can lose its
// memory while the people in it stay connected — so who is here is asked for
// on every call rather than kept, and a room that wakes up with nothing knows
// as much as one that never slept.
//
// The wire. These games have different protocols and always will, so nothing
// here is a message. A `Decision` says what happened; turning that into
// something to send is the game's, and is where its own vocabulary goes.

import { Fingerprints } from './fingerprints.ts'
import { Lobby, type Check, type LobbyState, type LobbyView } from './lobby.ts'
import { Match, type Handover, type Origin } from './match.ts'
import { admit } from './door.ts'
import { freeChairs, hostChair, resizeChairs, type Seated } from './seating.ts'
import type { At } from './log.ts'
import type { Clock } from './schedule.ts'
import type { Listed } from './listing.ts'

/**
 * One connection, as the room needs to see it.
 *
 * `who` is the caller's own handle for it and is only ever compared by
 * identity — a socket, an id, whatever the host deals in. The room never looks
 * inside it.
 */
export interface Member<Who, Seat> {
  readonly who: Who
  /** Chairs this connection holds. One each usually; several for a couch. */
  readonly chairs: readonly number[]
  /** What they call themselves. Another player's input — see `Arrival`. */
  readonly name: string
  /** This connection's own blob per chair. Never read here. */
  readonly seats?: readonly (Seat | undefined)[]
  /** Which places in the running match it speaks for. Empty in the lobby. */
  readonly players: readonly number[]
}

/** What the room settled on at the drop, for everybody to build the same match. */
export interface Seating<Seat> {
  /**
   * Places the match is laid out for, empty ones included.
   *
   * The room's own number and not the turnout: the spare places are the ones
   * something automatic keeps warm, and they are exactly what a latecomer can
   * be given. A game whose field size comes out of its own settings works this
   * out and says so; one that always lays out for the whole room says that.
   *
   * It used to be called the roster and was two things at once — this, and
   * whatever a game happened to call the number it sent its clients. One of
   * them lays out six places whatever the turnout and means something else
   * entirely by its roster, so the two were only ever equal by accident.
   */
  readonly places: number
  /** The chair each place came from, in place order. */
  readonly chairs: readonly number[]
  /** What each place calls itself. Another player's input — see `Arrival`. */
  readonly names: readonly string[]
  /** Each place's own blob, in place order. */
  readonly seats: readonly (Seat | null)[]
  /** Which places each connection speaks for. */
  readonly dealt: readonly { readonly who: Who_; readonly players: readonly number[] }[]
}
// Declared separately so `Seating` can name it without a second parameter
// everywhere it is used; the caller's handle is opaque either way.
type Who_ = unknown

/** Everything the room decided, for the caller to carry out. */
export type Decision<Who, Settings, Seat> =
  /** Not coming in. Nothing else in the list applies to them. */
  | { readonly kind: 'refuse'; readonly who: Who; readonly reason: string }
  /** In, with these chairs. */
  | { readonly kind: 'seated'; readonly who: Who; readonly chairs: readonly number[] }
  /** In, but a match is already running, so watching until they ask to play. */
  | { readonly kind: 'watching'; readonly who: Who }
  | { readonly kind: 'arrived'; readonly who: Who; readonly name: string }
  | { readonly kind: 'left'; readonly who: Who; readonly name: string }
  /** The room as everybody in it should now see it. */
  | { readonly kind: 'lobby'; readonly view: LobbyView<Settings, Seat> }
  /** The drop. Everybody builds the same match from this. */
  | { readonly kind: 'begun'; readonly seating: Seating<Seat> }
  /** Places changing hands, each dated to a point everybody can still reach. */
  | { readonly kind: 'handovers'; readonly changes: readonly Handover[] }
  /** A whole assignment, applied by everybody on one point. */
  | { readonly kind: 'lineup'; readonly at: At; readonly driving: readonly number[] }
  /** One connection now speaks for this place, from this point. -1 for none. */
  | { readonly kind: 'drives'; readonly who: Who; readonly player: number; readonly at: At }
  /** Somebody needs the match replayed to them: a latecomer, or a repair. */
  | {
      readonly kind: 'catchup'
      readonly who: Who
      /** A repair rather than an arrival — they were here and came apart. */
      readonly repair: boolean
      /** Which places they speak for, empty while watching. */
      readonly players: readonly number[]
      readonly seating: Seating<Seat>
      readonly origin: Origin | null
      readonly from: At
      readonly at: At
      readonly log: number[][]
      readonly handovers: readonly Handover[]
    }
  /** Two clients have stopped playing the same game. */
  | { readonly kind: 'disagreed'; readonly at: At }
  /**
   * Put the room on the public list under these terms, or take it off.
   *
   * `code` is carried rather than looked up afterwards, because taking a room
   * off the list is the same moment it stops having one: read back from the
   * room, the delisting has nothing to name and the entry sits there until it
   * goes stale.
   */
  | { readonly kind: 'listed'; readonly entry: Listed | null; readonly code: string }
  /** Worth writing down. A room can lose its memory with people still in it. */
  | { readonly kind: 'remember'; readonly state: LobbyState<Settings>; readonly started: boolean }
  /**
   * Look at this room again in this many milliseconds, or null to stop.
   *
   * It comes with the first arrival as well as with every beat, because a
   * heartbeat only ever rescheduled by itself is one that never starts. The
   * failure is silent in the worst way: everything works, and forty-five
   * seconds later the room falls off the public list and nobody is ever
   * noticed going quiet again.
   */
  | { readonly kind: 'wake'; readonly inMs: number | null }
  /** Everybody has gone. Throw the room away so its code can be used again. */
  | { readonly kind: 'recycle' }

export interface RoomOptions<Who, Settings, Seat> {
  /** The most chairs this room has. */
  readonly capacity: number
  /** The most places a match here is laid out for. */
  readonly roster: number
  readonly clock: Clock
  /** How long somebody may say nothing before they are called quiet. */
  readonly silenceMs: number
  /** How long a log may get before the match cuts it back. Never, if left out. */
  readonly keep?: number
  /** How many disagreement points to remember. */
  readonly recall: number
  /** How often a room with nothing going on should be looked at. */
  readonly heartbeatMs: number
  /**
   * How often a room with a match running should be looked at.
   *
   * Left out, the heartbeat does both, and that is usually far too slow to be
   * a presence clock: a beat pitched to keep a listing alive is tens of
   * seconds, which is also longer than a host keeps an idle object in memory —
   * so by the time it fires the room has forgotten the match, and a resumed
   * match rightly refuses to date anything until somebody contributes. A room
   * that is actually being played is awake anyway, so looking at it every
   * second costs nothing it was not already spending.
   *
   * One of these games worked that out for itself and the other did not.
   */
  readonly paceMs?: number
  readonly settings: Settings
  readonly checkSettings: Check<Settings>
  readonly checkSeat: Check<Seat>
  /** Who is here right now. Asked rather than kept — see the note at the top. */
  readonly members: () => readonly Member<Who, Seat>[]
  /**
   * What one of a connection's chairs is called.
   *
   * Numbered off the connection's name by default rather than asked for
   * separately: somebody setting up four controllers is not going to type four
   * names, and "Chris 3" is enough for the person beside Chris to know which
   * one is theirs.
   */
  readonly name?: (name: string, index: number) => string
  /**
   * Whether a chosen blob means they are in the match.
   *
   * Needed because the blob is opaque and "no preference" is a thing people
   * ask for: a chair whose person has not said where they want to sit is left
   * out of the numbering entirely rather than parked somewhere, so the place
   * indices stay packed from zero and that person starts as a watcher. Without
   * this the room would have to read the blob to tell those apart, which is
   * the one thing it does not do. Everybody plays, if left out.
   */
  readonly plays?: (seat: Seat) => boolean
}

const defaultName = (name: string, i: number): string => (i === 0 ? name : `${name} ${i + 1}`)

export class Room<Who, Settings, Seat> {
  private readonly opts: RoomOptions<Who, Settings, Seat>
  private readonly lobby: Lobby<Settings, Seat>
  private readonly prints: Fingerprints
  readonly match: Match
  private running = false
  /**
   * What the match started on, so a latecomer can be told the same thing.
   *
   * Null after the room has lost its memory mid-match, and the guards read it:
   * a room that cannot describe a match to somebody has no business seating
   * them in it. The people already playing carry on regardless — their
   * simulations are their own and the room is only relaying between them.
   */
  private laid: Seating<Seat> | null = null

  constructor(opts: RoomOptions<Who, Settings, Seat>) {
    this.opts = opts
    this.lobby = new Lobby<Settings, Seat>({
      settings: opts.settings,
      checkSettings: opts.checkSettings,
      checkSeat: opts.checkSeat,
    })
    this.prints = new Fingerprints({ keep: opts.recall })
    this.match = new Match({
      players: opts.roster,
      silenceMs: opts.silenceMs,
      clock: opts.clock,
      keep: opts.keep,
    })
  }

  get started(): boolean {
    return this.running
  }

  get settings(): Settings {
    return this.lobby.settings
  }

  get build(): string {
    return this.lobby.build
  }

  get code(): string {
    return this.lobby.code
  }

  /** What the match was laid out as, or null if this room has forgotten it. */
  get seating(): Seating<Seat> | null {
    return this.laid
  }

  /** Put back what was written down. A room waking with people still in it. */
  restore(state: Partial<LobbyState<Settings>>, started: boolean): void {
    this.lobby.restore(state)
    this.running = started
  }

  /**
   * Pick a running match back up in a room that never saw it start.
   *
   * A room's memory can be lost while the people in it stay connected — a
   * restart, a redeploy, a host that sheds idle objects and rebuilds them on
   * the next message. Left to itself it does two wrong things at once, both
   * silently: the clock has heard from nobody, so everybody is called quiet a
   * moment later and every place goes to the computer on a silence that never
   * happened; and with no history the schedule anchors on "never spoke", so
   * those decisions are dated to the opening of a match that is thousands of
   * points along.
   *
   * The connections are the only evidence left, and they are enough.
   */
  private wake(now: number): void {
    if (!this.running || this.match.started) return
    this.match.resume({ roster: this.places(), playing: [...this.holders()], now })
  }

  private holders(): Set<number> {
    const out = new Set<number>()
    for (const m of this.opts.members()) for (const p of m.players) out.add(p)
    return out
  }

  private seatedOf(except?: Who): Seated<Seat>[] {
    const out: Seated<Seat>[] = []
    for (const m of this.opts.members()) {
      if (except !== undefined && m.who === except) continue
      out.push({ chairs: m.chairs, name: m.name, seats: m.seats })
    }
    return out
  }

  private free(except?: Who): number[] {
    return freeChairs(this.seatedOf(except), this.opts.capacity)
  }

  private nameOf(name: string, i: number): string {
    return this.opts.name?.(name, i) ?? defaultName(name, i)
  }

  /** The room as everybody in it sees it. */
  private view(except?: Who): LobbyView<Settings, Seat> {
    const seen = this.seatedOf(except)
    return this.lobby.view(seen, this.opts.capacity, (s, i) => this.nameOf(s.name, i), hostChair(seen))
  }

  /**
   * How many places the running match is laid out for.
   *
   * Asked for rather than re-derived, because there are three places to ask
   * and they used to give two different answers. `Match` holds it while it is
   * running. The lobby state holds it across a room losing its memory, which
   * is the one moment `Match` cannot answer — a resumed match knows it is
   * running without knowing anything about the shape of it.
   *
   * `roster` is the fallback and not the answer: it is the most places this
   * room could ever lay out, which is only the layout by coincidence. A room
   * woken from a version that did not write the number down has nothing
   * better, and is no worse off than it was.
   */
  private places(): number {
    if (this.match.places > 0) return this.match.places
    return this.lobby.places > 0 ? this.lobby.places : this.opts.roster
  }

  /** How long until this room next wants looking at. */
  private beat(): number {
    return this.running ? (this.opts.paceMs ?? this.opts.heartbeatMs) : this.opts.heartbeatMs
  }

  /** Whether this connection holds the lowest chair, which is the host's. */
  isHost(who: Who, except?: Who): boolean {
    const chair = hostChair(this.seatedOf(except))
    for (const m of this.opts.members()) {
      if (m.who === who) return m.chairs.includes(chair)
    }
    return false
  }

  /** What the last listing said, so an unchanged one is not said again. */
  private said = ''
  private saidAt = -Infinity

  /**
   * The listing, but only when there is any point in saying it again.
   *
   * For the clock, which now runs often enough to notice somebody going quiet
   * — and a listing is a call to another object, so saying it on every beat
   * turns a room being played into one making a cross-object call a second,
   * for ever, whether or not anything changed. A private room's is a request
   * to remove an entry it never had.
   *
   * That is not merely wasteful. A host that gates incoming events behind an
   * outstanding call spends the gap not relaying anybody's input, and a match
   * where two people are each waiting on the other stops dead.
   *
   * Every other caller is an actual change — somebody arrived, took a chair,
   * started a match — and says it unconditionally.
   */
  private worthSaying(now: number): Extract<Decision<Who, Settings, Seat>, { kind: 'listed' }> | null {
    const d = this.listing(now) as Extract<Decision<Who, Settings, Seat>, { kind: 'listed' }>
    // Everything but when it was last confirmed, which differs every time and
    // is the whole reason a plain comparison would never match.
    const what =
      d.entry === null
        ? `off:${d.code}`
        : `${d.code}|${d.entry.host}|${d.entry.players}|${d.entry.max}|${d.entry.live}|${d.entry.build}`
    if (what === this.said && now - this.saidAt < this.opts.heartbeatMs) return null
    this.said = what
    this.saidAt = now
    return d
  }

  /** Whether the room belongs on the public list right now, and as what. */
  private listing(now: number, except?: Who): Decision<Who, Settings, Seat> {
    const seen = this.seatedOf(except)
    const taken = seen.reduce((n, s) => n + s.chairs.length, 0)
    const show =
      this.lobby.announced && this.lobby.code !== '' && taken > 0 && taken < this.opts.capacity
    if (!show) return { kind: 'listed', entry: null, code: this.lobby.code }
    const host = seen.reduce((a, b) => ((a.chairs[0] ?? 99) <= (b.chairs[0] ?? 99) ? a : b))
    return {
      kind: 'listed',
      code: this.lobby.code,
      entry: {
        code: this.lobby.code,
        host: host.name,
        players: taken,
        max: this.opts.capacity,
        since: this.lobby.since,
        live: this.running,
        build: this.lobby.build,
        updated: now,
      },
    }
  }

  private catchupFor(who: Who, players: readonly number[], repair: boolean): Decision<Who, Settings, Seat>[] {
    if (this.laid === null) return []
    const caught = this.match.catchup()
    return [
      {
        kind: 'catchup',
        who,
        repair,
        players,
        seating: this.laid,
        origin: caught.origin,
        from: caught.from,
        at: caught.at,
        log: caught.log,
        handovers: caught.handovers,
      },
    ]
  }

  /**
   * Somebody at the door.
   *
   * The caller has not seated them yet — it cannot, because it does not know
   * whether they are coming in. `seated` in the returned list is the
   * instruction to do it, with the chair to use.
   */
  arrive(
    who: Who,
    arrival: { name: string; build: string; announce: boolean; code: string },
    now: number,
  ): Decision<Who, Settings, Seat>[] {
    this.wake(now)
    const door = admit(
      {
        free: this.free(),
        started: this.running,
        vacant: this.running ? this.match.vacant(this.holders()) : -1,
        build: this.lobby.build,
      },
      { name: arrival.name, build: arrival.build },
    )
    if (door.as === 'refuse') return [{ kind: 'refuse', who, reason: door.reason }]

    const out: Decision<Who, Settings, Seat>[] = []
    // Whoever opens the room sets its terms: the build everybody must match,
    // and whether it is offered publicly. Read from that arrival alone — the
    // lowest chair is handed out again the moment its occupant leaves, so
    // taking it from whoever is in it lets a joiner put a private room on the
    // board over the heads of the people still in it.
    if (door.as === 'play' && door.opener) {
      this.lobby.open({
        build: arrival.build,
        code: arrival.code,
        announced: arrival.announce,
        now,
      })
      out.push({ kind: 'remember', state: this.lobby.snapshot(), started: this.running })
    }
    out.push({ kind: 'seated', who, chairs: [door.chair] })
    if (door.as === 'watch') out.push({ kind: 'watching', who })
    return out
  }

  /**
   * Once the caller has actually seated them. Split from `arrive` because the
   * lobby everybody is shown, and the match a latecomer is given, both have to
   * describe a room that already includes them.
   */
  arrived(who: Who, name: string, now: number): Decision<Who, Settings, Seat>[] {
    this.wake(now)
    const out: Decision<Who, Settings, Seat>[] = []
    // Walking into a game already going. Watching to begin with: a watcher
    // holds no place, so there is no seat to work out at the moment they
    // arrive, and nobody waits on them either. Choosing a side comes after, on
    // its own, when they are ready.
    if (this.running && this.laid !== null) {
      out.push(...this.catchupFor(who, [], false))
      out.push({ kind: 'arrived', who, name })
    }
    out.push({ kind: 'lobby', view: this.view() })
    out.push(this.listing(now))
    out.push({ kind: 'wake', inMs: this.beat() })
    return out
  }

  /**
   * How many chairs this connection wants.
   *
   * Only the move, and never the room afterwards. Anything describing the room
   * as everybody sees it has to be asked for once the caller has actually made
   * the move — this cannot see a change that has not happened yet, so a lobby
   * returned alongside a seating describes the room as it was a moment ago.
   * That is `refresh`, and the split is the same one `arrive` and `arrived`
   * make for the same reason.
   */
  chairs(who: Who, want: number): Decision<Who, Settings, Seat>[] {
    if (this.running) return []
    if (!Number.isInteger(want) || want < 1 || want > this.opts.capacity) return []
    const mine = this.opts.members().find((m) => m.who === who)
    if (mine === undefined) return []
    return [{ kind: 'seated', who, chairs: resizeChairs(mine.chairs, want, this.free()) }]
  }

  /**
   * The room as everybody in it should now see it, and nothing else.
   *
   * For the paths that change what is on the screen without moving anybody:
   * somebody picking a side, somebody changing their mind. Asking for it by
   * pretending to resize a connection's chairs works and is a trap — it sends
   * that person a fresh seating as well, which their client reads as having
   * just walked in.
   */
  refresh(now = Date.now()): Decision<Who, Settings, Seat>[] {
    return [{ kind: 'lobby', view: this.view() }, this.listing(now)]
  }

  /** Somebody's own choice for one of their chairs. Theirs alone to make. */
  choose(who: Who, chair: number, raw: unknown): Seat | null {
    const mine = this.opts.members().find((m) => m.who === who)
    if (mine === undefined || !mine.chairs.includes(chair)) return null
    return this.lobby.choose(raw)
  }

  /** The host proposes what everybody plays. */
  propose(who: Who, raw: unknown, now = Date.now()): Decision<Who, Settings, Seat>[] {
    const next = this.lobby.propose(this.isHost(who), this.running, raw)
    if (next === null) return []
    return [
      { kind: 'remember', state: this.lobby.snapshot(), started: this.running },
      { kind: 'lobby', view: this.view() },
      // The card a room shows on the public list can be built out of its
      // settings — which arena you would be walking into, which two sides are
      // playing — and this cannot know whether this game's is. Re-listing is
      // cheap and saying nothing leaves the board advertising a room that has
      // changed underneath it.
      this.listing(now),
    ]
  }

  /** Whether to offer the room publicly. The host's, like the settings. */
  announce(who: Who, on: boolean, now = Date.now()): Decision<Who, Settings, Seat>[] {
    if (this.running || typeof on !== 'boolean') return []
    if (!this.lobby.announce(this.isHost(who), on)) return []
    return [
      { kind: 'remember', state: this.lobby.snapshot(), started: this.running },
      { kind: 'lobby', view: this.view() },
      this.listing(now),
    ]
  }

  /** Everybody who has said what they want, in chair order, packed from zero. */
  private layOut(places: number): Seating<Seat> | null {
    const taken: { chair: number; name: string; seat: Seat; who: Who }[] = []
    for (const m of this.opts.members()) {
      for (let i = 0; i < m.chairs.length; i++) {
        const chair = m.chairs[i]!
        const seat = m.seats?.[i]
        // A chair whose person has not said where they want to sit is left out
        // of the numbering entirely rather than parked somewhere, so the place
        // indices stay packed from zero and that person starts as a watcher —
        // which the game already knows how to be, because it is what everybody
        // who joins late is.
        if (seat === undefined) continue
        if (this.opts.plays !== undefined && !this.opts.plays(seat)) continue
        taken.push({ chair, name: this.nameOf(m.name, i), seat, who: m.who })
      }
    }
    if (taken.length === 0) return null
    taken.sort((a, b) => a.chair - b.chair)
    const dealt: { who: Who; players: number[] }[] = []
    for (const m of this.opts.members()) {
      dealt.push({
        who: m.who,
        players: m.chairs.map((c) => taken.findIndex((p) => p.chair === c)).filter((i) => i >= 0),
      })
    }
    return {
      // Never fewer than the turnout: somebody who is here and has said where
      // they want to sit cannot be left off the field they are standing on.
      places: Math.max(places, taken.length),
      chairs: taken.map((p) => p.chair),
      names: taken.map((p) => p.name),
      seats: taken.map((p) => p.seat),
      dealt: dealt as Seating<Seat>['dealt'],
    }

  }

  /**
   * The drop.
   *
   * `places` is how many the match is laid out for, and it is the caller's to
   * decide because only the game knows where the number comes from — a fixed
   * field, or something out of its own settings. Bounded here by the room's
   * capacity, because a match cannot be laid out for more places than there
   * are chairs to fill them from.
   */
  begin(who: Who, places: number, now: number): Decision<Who, Settings, Seat>[] {
    if (!this.isHost(who) || this.running) return []
    if (!Number.isInteger(places) || places < 1 || places > this.opts.roster) return []
    const laid = this.layOut(places)
    if (laid === null) return []
    this.running = true
    this.prints.clear()
    this.laid = laid
    // Written down at the drop, because it is the one thing about a running
    // match that a room waking up with no memory cannot work out again.
    this.lobby.lay(laid.places)
    // Everybody is present at the drop. Without this they are all silent since
    // the epoch and the room retires the lot of them on the first point.
    this.match.begin({
      roster: laid.places,
      playing: laid.dealt.flatMap((d) => [...d.players]),
      now,
    })
    return [
      { kind: 'remember', state: this.lobby.snapshot(), started: true },
      { kind: 'begun', seating: laid },
      this.listing(now),
      // The cadence changes here. A room being played wants looking at often
      // enough to notice silence, and saying so only at the next beat means
      // the first beat of a match is still a lobby's.
      { kind: 'wake', inMs: this.beat() },
    ]
  }

  /**
   * The same room, played again.
   *
   * A debounce that needs no clock: a room that has taken no input since it
   * last started has not been played yet, so a second press — or a tenth, from
   * ten people at once — does nothing until it has.
   */
  rematch(now: number): Decision<Who, Settings, Seat>[] {
    if (!this.running || this.laid === null) return []
    if (this.match.head < 0) return []
    this.prints.clear()
    this.match.begin({ roster: this.laid.places, playing: [...this.holders()], now })
    return [{ kind: 'begun', seating: this.laid }]
  }

  /** A run of input from somebody, and whatever the clock makes of it. */
  input(who: Who, player: number, from: At, run: readonly number[], now: number): Decision<Who, Settings, Seat>[] {
    this.wake(now)
    const mine = this.opts.members().find((m) => m.who === who)
    // A connection may only speak for the places it was dealt. Checked rather
    // than corrected, because one connection can drive several of them and
    // overwriting the sender's own is not a thing that can be done.
    if (mine === undefined || !mine.players.includes(player)) return []
    const out: Decision<Who, Settings, Seat>[] = []
    const changes = this.match.contribute(player, from, run, now) ?? []
    if (changes.length > 0) out.push({ kind: 'handovers', changes })
    const quiet = this.match.observe(this.holders(), now)
    if (quiet.length > 0) out.push({ kind: 'handovers', changes: quiet })
    return out
  }

  /**
   * The clock. Everything else here is measured against whoever is furthest
   * along, which fails at the moment that player stops too — so a room that
   * has gone quiet needs somebody to look at it who is not in it.
   */
  tick(now: number): Decision<Who, Settings, Seat>[] {
    this.wake(now)
    const out: Decision<Who, Settings, Seat>[] = []
    if (this.running) {
      const quiet = this.match.observe(this.holders(), now)
      if (quiet.length > 0) out.push({ kind: 'handovers', changes: quiet })
    }
    const listed = this.worthSaying(now)
    if (listed !== null) out.push(listed)
    out.push({ kind: 'wake', inMs: this.beat() })
    return out
  }

  /** A world somebody offers as a place the match could be replayed from. */
  world(who: Who, at: At, state: unknown): Decision<Who, Settings, Seat>[] {
    // One authority, because somebody has to be the answer. If two machines
    // disagree one of them is broken, and working out which is not the problem
    // to solve — everybody agreeing is. A disagreement is still reported.
    if (!this.running || !this.isHost(who)) return []
    this.match.offer(at, state)
    return []
  }

  /** Somebody's fingerprint of a point, and whether it is news. */
  fingerprint(at: At, hash: number): Decision<Who, Settings, Seat>[] {
    return this.prints.offer(at, hash) ? [{ kind: 'disagreed', at }] : []
  }

  /** Their game came apart and they want it back. */
  repair(who: Who): Decision<Who, Settings, Seat>[] {
    const mine = this.opts.members().find((m) => m.who === who)
    if (!this.running || mine === undefined || mine.players.length === 0) return []
    return this.catchupFor(who, mine.players, true)
  }

  /**
   * Which place somebody watching could take, or -1 for standing down.
   *
   * A question rather than an event, because the answer depends on where
   * everybody sits and the caller has to move them before that is settled.
   * Seat them, then call `settle`, and tell them the point it names — working
   * the two out separately is how the halves of one swap end up on different
   * points, which is a room where some machines have made the change and
   * others have not.
   *
   * `where` narrows it to places the asker is willing to take; null is asking
   * to stand down.
   */
  take(who: Who, where: ((player: number) => boolean) | null): number | null {
    if (!this.running) return null
    const mine = this.opts.members().find((m) => m.who === who)
    if (mine === undefined) return null
    if (where === null) return mine.players.length === 0 ? null : -1
    const spare = this.match.vacant(this.holders(), where)
    return spare < 0 ? null : spare
  }

  /**
   * Seat one person in one place, and date it.
   *
   * The other half of `take`, for a game where control belongs to whoever was
   * given it and stays there. `settle` is for the other kind, where the whole
   * assignment is re-derived because control wanders — one of these games hands
   * you the ball-carrier, and there the only answer that holds is the whole
   * seating at once.
   *
   * Called once the caller has actually moved them, because the point it is
   * dated to depends on where everybody sits.
   */
  sit(player: number, now: number): Handover {
    return this.match.seat(player, now)
  }

  /**
   * Somebody gives a place up, and it goes to whatever drives it automatically.
   *
   * The other half of `sit`, and the pair of them is how one person changing
   * their mind is expressed: one place given up, one taken, each dated on its
   * own. Nobody else's is touched, which is the point — a whole reseating to
   * move one person tells every other client something about every place, and
   * a client that has not yet played the point it names goes on waiting for a
   * place that has already stopped speaking.
   */
  stand(player: number, now: number): Handover[] {
    return this.match.leave(player, now)
  }

  /**
   * Say who drives what, as one decision dated to one point.
   *
   * Called once the caller has actually moved somebody, because the answer
   * depends on where everybody sits afterwards.
   */
  settle(now: number): { at: At; driving: number[] } {
    const holders = this.holders()
    const changes: { p: number; on: boolean }[] = []
    const places = this.places()
    for (let p = 0; p < places; p++) changes.push({ p, on: !holders.has(p) })
    const line = this.match.reassign(changes, now)
    return { at: line.at, driving: [...holders].sort((a, b) => a - b) }
  }

  /**
   * Somebody has gone.
   *
   * Their places go straight to the computer rather than waiting to be
   * noticed. The clock would get there eventually, but only when somebody
   * else's input arrives to run it, and only after the silence has run its
   * course — and there is nothing to wait to find out. The socket is gone.
   */
  depart(
    who: Who,
    /**
     * What they held, said rather than looked up.
     *
     * Looking it up works only while the caller has not removed them yet, and
     * whether it has is a detail of the host — a socket that has closed is
     * still listed on one runtime and gone on another. Taken from the
     * membership, a host that removes first loses every handover silently,
     * with nothing anywhere to say so.
     */
    gone: { readonly name: string; readonly players: readonly number[] },
    now: number,
  ): Decision<Who, Settings, Seat>[] {
    this.wake(now)
    const out: Decision<Who, Settings, Seat>[] = [{ kind: 'left', who, name: gone.name }]
    if (this.running) {
      const changes: Handover[] = []
      for (const p of gone.players) {
        if (p < 0 || p >= this.places()) continue
        changes.push(...this.match.leave(p, now))
      }
      if (changes.length > 0) out.push({ kind: 'handovers', changes })
    }
    const remaining = this.opts.members().filter((m) => m.who !== who)
    if (remaining.length === 0) {
      // Take the listing down before the room is thrown away: wiping the
      // storage loses the code the entry is filed under, so doing it the other
      // way round strands the entry until it goes stale.
      // Named before the room forgets it: the delisting has to say which entry
      // it means, and a moment later there is nothing left to ask.
      const code = this.lobby.code
      this.running = false
      this.laid = null
      this.match.end()
      this.prints.clear()
      this.lobby.restore({
        settings: this.opts.settings,
        announced: false,
        build: '',
        code: '',
        since: 0,
        places: 0,
      })
      out.push({ kind: 'listed', entry: null, code })
      out.push({ kind: 'wake', inMs: null })
      out.push({ kind: 'recycle' })
      return out
    }
    // The departing connection is still a member as far as the caller is
    // concerned, so it is excluded explicitly or a room that just emptied a
    // chair still advertises itself as full.
    out.push({ kind: 'lobby', view: this.view(who) })
    out.push(this.listing(now, who))
    return out
  }
}
