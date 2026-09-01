// A match, as the room holds it.
//
// The pieces underneath — the log, the presence clock, the schedule — are each
// simple and each independently tested. Every bug that has actually happened
// with them was in the *joins* between them: three fields that had to be set
// together and were not, and six statements that had to run in one order and
// ran in another.
//
// So this owns the transitions rather than the parts. A room asks for a thing
// that happened — a match began, somebody spoke, somebody went quiet, somebody
// took a place — and is handed back the decisions to broadcast. There is no
// order to get wrong because there is only ever one call.
//
// It still knows nothing about sockets, storage or timers. Those stay the
// room's, and always did; what moves here is the sequencing.

import { ContributionLog, type At } from './log.ts'
import { Presence } from './presence.ts'
import { DecisionLog, type Clock } from './schedule.ts'

/**
 * Several places changing hands at once, on one point.
 *
 * The unit a room decides in, because a change is very often more than one
 * place: switching sides is giving one up and taking another, and those are two
 * halves of a single thing. Dated separately they get separate points — measured
 * at eighty ticks apart here, and at a hundred and twenty in the game this was
 * taken from, which leaves every client playing a different match in between.
 */
export interface Lineup {
  readonly at: At
  readonly changes: readonly Handover[]
}

/**
 * Where a replay starts.
 *
 * A seed is only the cheapest way of writing one down. Once a state at a later
 * point exists, everything before it is re-derivable from it and costs nothing
 * but memory to keep — which is what lets a match run longer than the log a
 * room is willing to hold.
 *
 * `state` is the game's and is never opened here.
 */
export interface Origin {
  readonly at: At
  readonly state: unknown
}

/** A change of driver, dated to a point everybody can still reach. */
export interface Handover {
  readonly p: number
  readonly at: At
  /** True when the place goes to whatever drives it automatically. */
  readonly on: boolean
}

export interface MatchOptions {
  /** The most players the room could ever hold. */
  readonly players: number
  readonly clock: Clock
  /** How long somebody may say nothing before they are called quiet. */
  readonly silenceMs: number
  /**
   * How long the log may get before the match cuts it back to a world
   * somebody has published.
   *
   * Left out, it never cuts, which is the right answer for most games: a match
   * of twenty turns, or one that lasts five minutes, will never reach any
   * limit worth having and the machinery is pure cost. It earns its place on
   * the long ones — six players at sixty a second is three hundred and sixty
   * numbers a second, and nothing else in a room grows like that.
   *
   * Measured in points, so what it means is whatever the clock means: ticks in
   * a rollback game, turns in a turn-based one.
   */
  readonly keep?: number
}

export interface BeginOptions {
  /**
   * Places a person could hold, empty ones included.
   *
   * The room's capacity, not the turnout. The spare places are driven
   * automatically from the first point, which is what leaves somewhere for a
   * latecomer to arrive into.
   */
  readonly roster: number
  /** Which of those places actually have somebody in them. */
  readonly playing: readonly number[]
  readonly now: number
}

export class Match {
  private readonly opts: MatchOptions
  private readonly contributions: ContributionLog<number>
  private readonly presence: Presence
  private readonly decisions = new DecisionLog<Handover>()
  /**
   * Whether the computer is driving this place right now.
   *
   * Not the same question as whether anybody holds it, and conflating the two
   * gave a newcomer somebody else's place: a player who has gone quiet is
   * driven by the computer *and* still theirs — they are lagging, not gone.
   */
  private readonly automatic: boolean[]
  private roster = 0
  private start: Origin | null = null
  /**
   * The newest world anybody has published, waiting for the log to be long
   * enough to be worth cutting to it.
   *
   * Held apart from `start` because the two are different questions. This is
   * the best place the match *could* start from; `start` is where it does. A
   * match that has never been long enough has a pending world and no origin.
   */
  private pending: Origin | null = null
  private running = false
  private knowsWhere = false

  constructor(opts: MatchOptions) {
    this.opts = opts
    this.contributions = new ContributionLog<number>({ players: opts.players })
    this.presence = new Presence({ players: opts.players, silenceMs: opts.silenceMs })
    this.automatic = new Array<boolean>(opts.players).fill(false)
  }

  get started(): boolean {
    return this.running
  }

  /**
   * Whether this object knows where the match has got to.
   *
   * False from the moment it is resumed until the first contribution arrives.
   * A room can lose its memory while the people in it stay connected — a
   * restart, a redeploy, a failover, a host that sheds idle objects and rebuilds
   * them on the next message — and what comes back knows the match is running
   * without knowing anything about when.
   */
  get oriented(): boolean {
    return this.knowsWhere
  }

  /**
   * How many places the match is laid out for, empty ones included.
   *
   * The match's own number, and the one to ask for rather than keep a second
   * copy of. A room's `roster` is the most places it could ever hold, which is
   * a different number the moment a game lays out for fewer — and answering
   * the first when you meant the second seats a latecomer in a place the match
   * was never laid out for.
   */
  get places(): number {
    return this.roster
  }

  /** The newest point anybody has spoken for. */
  get head(): At {
    return this.contributions.head
  }

  /**
   * The oldest point the log still holds. Zero until it has been compacted.
   *
   * Worth having on its own so that deciding whether to compact does not mean
   * building the whole log to read one number off it — which is a decision
   * taken every few seconds, on the longest logs in the room.
   */
  get from(): At {
    return this.contributions.origin
  }

  /** Whether this place is currently driven automatically. */
  isAutomatic(player: number): boolean {
    return this.automatic[player] === true
  }

  /**
   * Begin a match. One call, because the order inside it is load-bearing.
   *
   * Written out by hand this was six statements in two blocks twenty lines
   * apart, and the one that had to come last came first: the presence clock was
   * started before anybody had been dealt a place, so every clock read zero, the
   * first look called all of them quiet, and every place went to the computer on
   * the opening tick. Both ends then applied those handovers at different points
   * and played different matches. Nothing threw; two full test suites passed.
   */
  begin(o: BeginOptions): void {
    this.running = true
    this.start = null
    this.pending = null
    // A match that starts here starts at the origin, so where it has got to is
    // never in doubt. A resumed one is a different matter entirely.
    this.knowsWhere = true
    this.roster = o.roster
    this.contributions.clear()
    this.presence.clear()
    this.decisions.clear()
    this.automatic.fill(false)
    // The spare places are driven automatically from the first point. The room
    // has to know it, and not only the simulation: otherwise the schedule dates
    // the first latecomer's handover off a place that has never spoken, which
    // is hundreds of points in the past.
    const playing = new Set(o.playing)
    this.automatic.fill(false)
    for (let p = 0; p < o.roster && p < this.opts.players; p++) {
      if (!playing.has(p)) this.automatic[p] = true
    }
    // And only now, once there is somebody to start a clock for.
    for (const p of o.playing) this.presence.reset(p, o.now)
  }

  /**
   * Pick up a match that was already running, in a room that has forgotten it.
   *
   * Not the same as beginning one, and the difference is the whole reason this
   * exists. Beginning wipes the slate; resuming keeps the match and admits that
   * *this object* is new. Two things follow, and both were live failures:
   *
   * Nobody may be judged silent for time this object was not there for. A fresh
   * clock has heard from nobody, so a plain `begin` would find everybody four
   * seconds quiet a moment later and hand every place away at once.
   *
   * And nothing may be dated until the match says where it is. With no history
   * the schedule anchors on "never spoke", which is a point at the very start —
   * so a handover in a match thousands of points along gets dated to the
   * beginning, and every client rewinds for it, runs off the end of what it
   * keeps, and abandons it in silence.
   */
  resume(o: { roster: number; playing: readonly number[]; now: number }): void {
    this.running = true
    this.knowsWhere = false
    this.roster = o.roster
    // Who was driving what is gone with everything else, so the connections are
    // the only evidence: whoever is still here holds a place, and the rest of
    // the roster is the computer's. That is the same rule a match opens on, and
    // it is the best available — but it is a guess, which is the other reason
    // nothing may be dated until the match has said where it is.
    const playing = new Set(o.playing)
    this.automatic.fill(false)
    for (let p = 0; p < o.roster && p < this.opts.players; p++) {
      if (!playing.has(p)) this.automatic[p] = true
    }
    for (const p of o.playing) this.presence.reset(p, o.now)
  }

  /** Give the match back. A room being recycled for a fresh one. */
  end(): void {
    this.running = false
    this.start = null
    this.pending = null
    this.knowsWhere = false
    this.roster = 0
    this.contributions.clear()
    this.presence.clear()
    this.decisions.clear()
    this.automatic.fill(false)
  }

  /**
   * Somebody sent something.
   *
   * Records it, marks them heard, and hands back whatever that changes — which
   * is a place coming back off the computer when its player speaks again, and
   * otherwise nothing at all.
   *
   * Returns null if the claim was malformed, so a caller can tell that from an
   * ordinary message that changed nothing.
   */
  contribute(player: number, from: At, run: readonly number[], now: number): Handover[] | null {
    if (!this.contributions.record(player, from, run)) return null
    // The first thing anybody says is what tells a resumed room where the match
    // has got to. Until then it must not date anything.
    this.knowsWhere = true
    this.presence.hear(player, now)
    if (!this.automatic[player]) return []
    // Speaking again takes the place straight back, rather than waiting for the
    // next beat of the clock to notice.
    return [this.drive(player, false, now)]
  }

  /**
   * Somebody spoke, without saying anything about the timeline.
   *
   * The presence clock measures silence, not contributions — and on a netcode
   * where one machine simulates and describes what happened, that machine
   * never contributes at all: its own input never leaves it. Judged by the
   * input path alone, the room decides the one player it cannot do without has
   * gone quiet, and hands their place to something automatic while they are
   * sitting there driving it.
   *
   * Deliberately does not orient the match. A frame says somebody is alive; it
   * says nothing about where the match has got to, and dating a decision from
   * a guess about that is the whole reason `oriented` exists.
   */
  heard(player: number, now: number): void {
    if (!this.running) return
    this.presence.hear(player, now)
  }

  /**
   * Look at the clock and hand back what changed.
   *
   * Call this both when traffic arrives and on a timer. Traffic alone is free
   * and self-firing, because whoever is stalled is by definition still
   * transmitting; its one blind spot is a room where everybody has gone quiet at
   * once, and that is exactly when nothing else will fire either.
   */
  observe(held: Iterable<number>, now: number): Handover[] {
    // Nothing can be dated until the match says where it is — see `oriented`.
    if (!this.oriented) return []
    const change = this.presence.look(held, now)
    const out: Handover[] = []
    for (const p of change.quiet) if (!this.automatic[p]) out.push(this.drive(p, true, now))
    for (const p of change.back) if (this.automatic[p]) out.push(this.drive(p, false, now))
    return out
  }

  /** Somebody's connection went. Their place changes hands at once. */
  leave(player: number, now: number): Handover[] {
    if (!this.running || !this.oriented || player < 0 || this.automatic[player]) return []
    // No waiting to find out: the connection is gone. `observe` would get there
    // after the silence elapsed, and that is time everybody left spends stopped
    // for somebody who has closed their tab.
    return [this.drive(player, true, now)]
  }

  /** A place nobody holds, or -1. What a latecomer can be given. */
  vacant(held: Iterable<number>, where?: (player: number) => boolean): number {
    // A room that has forgotten the match has no place to give: seating
    // somebody in a match it cannot describe to them is worse than turning them
    // away, and it cannot describe one it has no history of.
    if (!this.running || !this.oriented) return -1
    // Free means nobody is answerable for it, never "the computer is driving
    // it" — a place whose player has gone quiet is both, and giving it away
    // takes it off somebody who is sitting right there. Who holds what is the
    // room's own record and is asked for rather than kept here: a copy is a
    // second answer to the same question, and the two drift.
    const taken = new Set(held)
    for (let p = 0; p < this.roster; p++) {
      if (taken.has(p)) continue
      if (where !== undefined && !where(p)) continue
      return p
    }
    return -1
  }

  /**
   * Give a place to somebody who has caught up.
   *
   * The handover it returns is the whole answer: the point it takes effect on
   * is the point everybody else is told about, so the two cannot disagree.
   */
  seat(player: number, now: number): Handover {
    return this.drive(player, false, now)
  }

  /**
   * Change several places at once, on one point.
   *
   * The only place a change of driver is dated, so a change that is really two
   * things — giving one place up and taking another — cannot come apart. Each
   * place is asked where it would go on its own and the batch takes the latest
   * of those answers: a point too far ahead costs a moment, a point already
   * passed costs the match, because a client rewinds for it, runs off the end of
   * its history, and abandons it in silence.
   *
   * Anchored per place because the right anchor differs. A place somebody is
   * still speaking for is dated off their own last word, since their peers stall
   * relative to that; a place already driven automatically is dated off the
   * room, because nobody is waiting on it and its own last word may be minutes
   * old — or, for a place that has never spoken, never.
   */
  reassign(changes: readonly { p: number; on: boolean }[], now: number): Lineup {
    const view = {
      head: this.contributions.head,
      lastFrom: (q: number) => this.contributions.lastFrom(q),
      isAutomatic: (q: number) => this.automatic[q] === true,
    }
    let at = this.contributions.head + 1
    for (const c of changes) {
      const want = this.opts.clock.schedule(view, c.p)
      if (want > at) at = want
    }
    const out: Handover[] = []
    for (const c of changes) {
      this.automatic[c.p] = c.on
      const h: Handover = { p: c.p, at, on: c.on }
      this.decisions.add(at, h)
      // Given a place back, the first point they can speak for is the one they
      // were given it on, and their answer still has a round trip to make.
      // Measured against anything earlier they are late before they have had a
      // chance to say anything, and the room takes it straight back off them.
      if (!c.on) this.presence.reset(c.p, now)
      out.push(h)
    }
    return { at, changes: out }
  }

  /**
   * Throw away everything before `at`, and remember the world as it was there.
   *
   * The only thing that keeps a long match from growing without bound. A room
   * that never simulates cannot produce the state itself, so it is given one —
   * by whoever the game has decided to believe, which is a question with one
   * sensible answer and no clever ones.
   *
   * Refused before the point the log already starts at, and refused past the
   * newest thing anybody has said: compacting into the future would throw away
   * contributions that are still the only record of what happened.
   */
  compact(at: At, state: unknown): boolean {
    if (!this.running) return false
    if (at <= this.contributions.origin || at > this.contributions.head) return false
    this.start = { at, state }
    this.contributions.compact(at)
    return true
  }

  /**
   * Somebody publishes a world the match could start from, and the match cuts
   * back to it once there is enough behind it to be worth cutting.
   *
   * The policy, where `compact` is the mechanism. Three rules, and every game
   * that grew a log wrote all three: keep the newest offer rather than the
   * first, never cut to a point the log has already passed, and do not bother
   * until the log is longer than `keep`.
   *
   * Who is allowed to publish one is not decided here, because a match does
   * not know about connections. It is the same rule as the settings — one
   * authority, so that a player who has fallen behind cannot rewrite where
   * everybody else begins — and the room applies it before calling this.
   *
   * Returns whether the offer was taken, not whether it caused a cut.
   */
  offer(at: At, state: unknown): boolean {
    if (!this.running || !Number.isInteger(at)) return false
    // Not past the head: a world from the future would throw away
    // contributions that are the only record of what happened.
    if (at > this.contributions.head) return false
    // Newer than both what is held and what is already in use.
    if (at <= (this.pending?.at ?? -1) || at <= this.contributions.origin) return false
    this.pending = { at, state }
    const keep = this.opts.keep
    if (keep !== undefined && this.contributions.head - this.contributions.origin > keep) {
      this.compact(this.pending.at, this.pending.state)
    }
    return true
  }

  /** Where a replay of this match has to start. Null while it starts at the beginning. */
  get origin(): Origin | null {
    return this.start
  }

  /** Everything a latecomer needs to replay the match to the present. */
  catchup(): { origin: Origin | null; from: At; at: At; log: number[][]; handovers: Handover[] } {
    return {
      // Where the rows below begin. Zero until the log has been compacted, and
      // the state to begin from once it has — a replay that started at the
      // beginning regardless would be replaying inputs it does not have.
      origin: this.start,
      from: this.contributions.origin,
      at: this.contributions.head,
      log: this.contributions.rectangle(0).slice(0, this.roster),
      handovers: this.decisions.all().map((d) => d.body),
    }
  }

  /** Who is answerable for a place right now. */
  /**
   * Change who drives a place: date it, record it, apply it.
   *
   * All three together, because doing two of them was the other bug. A place
   * marked automatic in the simulation but not here is one the room goes on
   * waiting for input from — and the confirmation watermark waits with it,
   * taking every checkpoint fingerprint along, so divergence detection switches
   * itself off for the rest of the match with nothing to say so.
   */
  private drive(player: number, on: boolean, now: number): Handover {
    return this.reassign([{ p: player, on }], now).changes[0]!
  }
}
