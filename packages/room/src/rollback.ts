// The deterministic layer: rollback netcode over somebody else's simulation.
//
// Every client simulates at full speed and never waits for the network. A
// remote input we do not have yet is predicted — they repeat their last frame —
// and when the truth arrives and contradicts the guess we rewind to that point
// and resimulate forward. That is the whole idea; everything below is the
// bookkeeping that makes it exact.
//
// Nothing here knows what a game is. It creates states, copies them, steps
// them, hashes them and asks which point they are at, all through `Sim` — the
// smallest set of things you cannot write a rollback engine without. What a
// state contains, what an input means and who drives what are the game's, and
// this never looks inside any of them.

import { Watermark } from './watermark.ts'
import type { At } from './log.ts'

/**
 * What this needs from a simulation, and nothing more.
 *
 * Ten functions is not a small interface, and there is no honest way to make
 * it smaller: an engine that rewinds has to be able to create a state, copy
 * one over another, step it, hash it, write it down, read it back and ask what
 * point it is at. Each of these is one line in a game that already declares its
 * state as named fields.
 *
 * Inputs are opaque packed numbers, one per player, and are never unpacked
 * here. That is what keeps the seating out: a game that maps players to pieces,
 * lets them swap, or hands one player two of them does all of that inside its
 * own `step`, where it is already written.
 */
export interface Sim<State> {
  /** A state at the beginning. Everything it needs is the game's to close over. */
  create(): State
  clone(s: State): State
  copy(into: State, from: State): void
  /** Which point the state is at. The engine never sets this; `step` does. */
  pointOf(s: State): At
  /** Advance one point, given every player's packed input for it. */
  step(s: State, inputs: readonly number[]): void
  /** A fingerprint. Equal states must agree; different ones should not. */
  hash(s: State): number
  snapshot(s: State): number[]
  /** Put a state back. False if the data is not one — a short read, a bad build. */
  restore(s: State, data: readonly number[]): boolean
  /**
   * Whether this player is driving anything right now.
   *
   * Not the same as whether they exist. A player who holds nothing is not
   * somebody to wait for, and treating them as one stops the whole match on
   * input that is never coming.
   */
  holds(s: State, player: number): boolean
  /**
   * Hand a player's place to the computer, or give it back.
   *
   * Returns whether there was a place to hand over. False is ordinary: a
   * player between pieces, or one who has never had one.
   */
  automate(s: State, player: number, on: boolean): boolean
  /** A whole assignment the room decided. The blob is the game's and is not read here. */
  assign?(s: State, whole: unknown): void
  /** What happened this point, as a bitmask, for anything that reacts to events. */
  events?(s: State): number
}

export interface RollbackOptions<State> {
  readonly sim: Sim<State>
  /** Places the match is laid out for, empty ones included. */
  readonly players: number
  /** Which of those this machine supplies input for. */
  readonly localPlayers: number[]
  /** Places with nobody behind them, which are never waited on. */
  readonly absent?: number[]
  /** How far ahead of confirmed remote input we will run before stopping. */
  readonly window: number
  /** Wall-clock milliseconds per point. */
  readonly tickMs: number
  /** The packed input meaning "nothing", used before anybody has spoken. */
  readonly idle: number
  /** How often to fingerprint. Compared only once a point is settled. */
  readonly hashEvery: number
  /** How often to offer the room a world it could cut the log back to. */
  readonly snapshotEvery: number
  /** How far behind the field we tolerate before spending extra points to close up. */
  readonly catchupSlack: number
  /** How many extra points one frame may spend closing that gap. */
  readonly catchupPerFrame: number
  /**
   * Keep every input the match actually stepped with, for a replay file.
   *
   * Off by default, because it is the one thing here that grows with the
   * length of a match rather than with the window. On, it is what turns "he
   * let another one in from the blue line" into a file that fails: a bench
   * never plays the game a person plays, so without a recording half of what
   * gets reported cannot be reproduced, let alone tested.
   */
  readonly record?: boolean
}

/** A change of driver, dated to a point everybody can still reach. */
export interface Handover {
  readonly p: number
  readonly at: At
  readonly on: boolean
}

export class Rollback<State> {
  readonly state: State
  /** The state at the start of the current point, for interpolation. */
  readonly prev: State
  readonly opts: RollbackOptions<State>

  private readonly sim: Sim<State>
  private readonly ringSize: number
  private readonly ring: State[] = []
  private readonly ringAt: number[] = []
  /** What each player really sent, by point. */
  private readonly real: Map<At, number>[] = []
  /** What we actually stepped with, so a contradiction is detectable. */
  private readonly used: Map<At, number>[] = []
  private readonly lastValue: number[] = []
  private readonly lastReal: At[] = []
  private readonly hashAt = new Map<At, number>()
  /**
   * Every input the match stepped with, by player and point. See `record`.
   *
   * Written where `used` is written and indexed by point rather than appended,
   * so a resimulated point overwrites its own earlier guess and what is left
   * at the end is what really happened.
   */
  private readonly taped: number[][] = []
  private readonly water: Watermark
  private nextHash: number
  private acc = 0
  private pendingEvents = 0
  private eventsThrough = -1
  private offeredThrough = -1

  /** Diagnostics. */
  rollbacks = 0
  lineups = 0
  lastRollbackDepth = 0
  stalled = false

  /**
   * Points at which a place changes hands, held as a schedule rather than
   * applied on arrival.
   *
   * A rollback replays points either side of the change, so a handover done
   * once when the message landed would be undone by the next correction that
   * crossed it. Re-read every step instead, so resimulating a point reproduces
   * who was driving.
   */
  private readonly autoFrom = new Map<number, { at: At; on: boolean }>()
  /** A whole assignment the room named a point for. Kept, because a rollback has to put it back. */
  private assignAt: { at: At; whole: unknown } | null = null

  /** Set while replaying a match somebody else already played. See `catchUp`. */
  private bulkLog: number[][] | null = null
  private bulkKeep = -1
  /**
   * The point the log's first column is.
   *
   * Zero until the room has cut the log back to a world it kept, and the point
   * of that world afterwards. Every read of a row goes through it, because a
   * row that has had its front thrown away still describes the same points.
   */
  private bulkFrom = 0

  constructor(opts: RollbackOptions<State>) {
    this.opts = opts
    this.sim = opts.sim
    this.ringSize = opts.window * 3
    this.nextHash = opts.hashEvery
    this.state = this.sim.create()
    this.prev = this.sim.clone(this.state)
    this.water = new Watermark({ players: opts.players, absent: opts.absent })
    for (let i = 0; i < this.ringSize; i++) {
      this.ring.push(this.sim.clone(this.state))
      this.ringAt.push(-1)
    }
    for (let p = 0; p < opts.players; p++) {
      this.real.push(new Map())
      this.used.push(new Map())
      this.lastValue.push(opts.idle)
      this.lastReal.push(-1)
    }
    this.sim.copy(this.prev, this.state)
  }

  get at(): At {
    return this.sim.pointOf(this.state)
  }

  hash(): number {
    return this.sim.hash(this.state)
  }

  /** Fraction of the way through the current point, for interpolation. */
  get alpha(): number {
    return Math.min(1, this.acc / this.opts.tickMs)
  }

  /** Which places this machine speaks for. Changes when somebody takes a seat. */
  setLocal(players: number[]): void {
    ;(this.opts as { localPlayers: number[] }).localPlayers = players
  }

  /** Record a locally sampled input. Always authoritative for that player. */
  setLocalInput(player: number, at: At, packed: number): void {
    this.real[player]!.set(at, packed)
    if (at > this.lastReal[player]!) {
      this.lastReal[player] = at
      this.lastValue[player] = packed
    }
  }

  /**
   * Take a run of inputs from a peer, and rewind if any of them contradict
   * what we guessed for a point we have already played.
   */
  applyRemote(player: number, from: At, packed: readonly number[]): void {
    if (player < 0 || player >= this.opts.players) return
    let earliest = -1
    for (let i = 0; i < packed.length; i++) {
      const t = from + i
      const v = packed[i]!
      if (this.real[player]!.get(t) === v) continue
      this.real[player]!.set(t, v)
      if (t > this.lastReal[player]!) {
        this.lastReal[player] = t
        this.lastValue[player] = v
      }
      const was = this.used[player]!.get(t)
      if (was !== undefined && was !== v && (earliest < 0 || t < earliest)) earliest = t
    }
    if (earliest >= 0) this.rewindTo(earliest)
  }

  /**
   * The room says a place is the computer's from `at`, or its player's again.
   *
   * The point is the room's and can be behind ours by the time it arrives:
   * every client runs ahead of the newest confirmed input. That used to be
   * silent — the schedule was consulted only going forward, so two clients
   * that heard the same message at different moments played the same point
   * with different drivers and drifted apart with nothing to bring them back,
   * because no contradicted prediction ever arrives to trigger a rewind. So a
   * decision behind us rewinds to it, which is what the ring is for.
   */
  handover(player: number, at: At, on: boolean): void {
    const had = this.autoFrom.get(player)
    if (had !== undefined && had.at === at && had.on === on) return
    this.autoFrom.set(player, { at, on })
    if (on) this.water.released(player, at)
    else this.water.reclaimed(player, at)
    if (at < this.at) this.rewindTo(at)
  }

  /**
   * The room says this is who drives what, from `at`.
   *
   * `whole` is the game's blob and is handed straight back to it. `driving` is
   * the same decision in the one form this layer needs: who is answerable
   * afterwards. Both, rather than reading one out of the other, because
   * reading it means opening the blob.
   */
  lineup(at: At, whole: unknown, driving: readonly number[]): void {
    this.assignAt = { at, whole }
    // The path that never told the watermark anything. A whole seating says who
    // is driving as surely as a single handover does, and a player left out of
    // it has stopped being read from `at` — which is the fact the line needs.
    for (let p = 0; p < this.opts.players; p++) {
      if (driving.includes(p)) this.water.reclaimed(p, at)
      else this.water.released(p, at)
    }
    if (at < this.at) this.rewindTo(at)
  }

  private rewindTo(at: At): void {
    const slot = ((at % this.ringSize) + this.ringSize) % this.ringSize
    if (this.ringAt[slot] !== at) {
      // Older than the window; nothing to do but carry on and let the
      // fingerprints catch it. In practice this means a peer is far beyond the
      // prediction window behind, which the stall guard prevents.
      return
    }
    const target = this.at
    this.sim.copy(this.state, this.ring[slot]!)
    this.rollbacks++
    this.lastRollbackDepth = target - at
    while (this.at < target) this.stepOnce()
  }

  private inputFor(player: number, at: At): number {
    const bulk = this.bulkLog
    if (bulk !== null) {
      const row = bulk[player]
      const i = at - this.bulkFrom
      if (row !== undefined && i >= 0 && i < row.length) return row[i]!
    }
    const r = this.real[player]!.get(at)
    if (r !== undefined) return r
    return this.lastValue[player]! // predict: they keep doing what they were doing
  }

  private stepOnce(): void {
    const t = this.at
    // Whole-cloth, on the point the room named. Before the handovers below, so
    // one for the same point still has the last word.
    const whole = this.assignAt
    if (whole !== null && t === whole.at && this.sim.assign !== undefined) {
      this.lineups++
      this.sim.assign(this.state, whole.whole)
    }
    // Who is driving, recomputed from the schedule so it is the same on every
    // machine and the same on a replay of this point as it was the first time.
    for (const [p, d] of this.autoFrom) {
      if (t < d.at) continue
      if (!this.sim.automate(this.state, p, d.on)) continue
      // A place just handed back is not one whose owner is late. Their
      // watermark is whatever it was before they held anything — for somebody
      // who never has, -1 — and the stall guard reads that as hundreds of
      // points behind and stops the whole match until their first input
      // arrives, which is a round trip away. Nobody is late on the point they
      // are given something.
      if (!d.on && this.lastReal[p]! < d.at) this.lastReal[p] = d.at
    }
    // Deep in a catch-up replay, where nothing behind us will ever be read
    // again. The ring, the used map and the hashes all serve a rewind or a bug
    // report, and neither can reach back this far.
    const light = t < this.bulkKeep

    if (!light) {
      const slot = ((t % this.ringSize) + this.ringSize) % this.ringSize
      this.sim.copy(this.ring[slot]!, this.state)
      this.ringAt[slot] = t
    }

    const inputs = new Array<number>(this.opts.players)
    for (let p = 0; p < this.opts.players; p++) {
      const packed = this.inputFor(p, t)
      if (!light) {
        this.used[p]!.set(t, packed)
        if (this.opts.record === true) (this.taped[p] ??= [])[t] = packed
      }
      inputs[p] = packed
    }
    this.sim.step(this.state, inputs)

    // Per point, not per frame: a rendered frame covers however many points fit
    // inside it, so reading the mask once a frame silently drops everything but
    // the last one's. And only past the high-water mark, so a rewind replaying
    // points does not sound them a second time.
    if (!light && t > this.eventsThrough && this.sim.events !== undefined) {
      this.eventsThrough = t
      this.pendingEvents |= this.sim.events(this.state)
    }
    // Recorded every time this point is played. A rewind replays through it and
    // overwrites the entry, so what survives to confirmation is the final one.
    if (!light && t % this.opts.hashEvery === 0) {
      this.hashAt.set(t, this.sim.hash(this.state))
    }
  }

  /**
   * The match so far, as something that can be played again from nothing.
   *
   * Holes are filled with the last value rather than left sparse: a point a
   * player never spoke for is one they repeated themselves on, which is what
   * the prediction does anyway, and it keeps the file a plain rectangle.
   * Empty unless `record` was set.
   */
  tape(): number[][] {
    const to = this.at
    const rows: number[][] = []
    for (let p = 0; p < this.opts.players; p++) {
      const row = new Array<number>(to)
      let last = this.opts.idle
      for (let t = 0; t < to; t++) {
        last = this.taped[p]?.[t] ?? last
        row[t] = last
      }
      rows.push(row)
    }
    return rows
  }

  /** The newest point each player's real input is known for. For diagnostics. */
  lastRealAt(): At[] {
    return this.lastReal.slice()
  }

  /**
   * Which places the room has said are changing hands, and when.
   *
   * Whether a decision arrived at all is the first question to ask of a machine
   * playing a different game from everybody else.
   */
  schedule(): { p: number; at: At; on: boolean }[] {
    return [...this.autoFrom].map(([p, d]) => ({ p, at: d.at, on: d.on }))
  }

  /** Everything that happened since the last drain. */
  drainEvents(): number {
    const e = this.pendingEvents
    this.pendingEvents = 0
    return e
  }

  /** The newest point every player's real input is known for. Nothing at or before it can move. */
  confirmed(): At {
    return this.water.line((p, t) => this.real[p]!.has(t))
  }

  /**
   * A fingerprint safe to compare against a peer, or null.
   *
   * Hashing the current point is worthless: it is built from predicted remote
   * input, so two honest peers disagree at the moment they pass a point and
   * converge only once the real inputs arrive. Comparing those reports a
   * disagreement on essentially every checkpoint as soon as anybody moves.
   */
  takeConfirmedHash(): { at: At; h: number } | null {
    const confirmed = this.confirmed()
    while (this.nextHash <= confirmed) {
      const at = this.nextHash
      this.nextHash += this.opts.hashEvery
      const h = this.hashAt.get(at)
      if (h !== undefined) return { at, h }
    }
    return null
  }

  /**
   * A world worth offering the room, or null.
   *
   * Only from a settled point. A world from a point anybody is still guessing
   * about is built partly from guesses, and handing the room one of those is
   * how a guess becomes the thing everybody has to agree with.
   */
  takeSnapshot(): { at: At; data: number[] } | null {
    const line = this.confirmed()
    if (line < 0 || line <= this.offeredThrough) return null
    if (line % this.opts.snapshotEvery !== 0) return null
    const slot = ((line % this.ringSize) + this.ringSize) % this.ringSize
    if (this.ringAt[slot] !== line) return null
    this.offeredThrough = line
    return { at: line, data: this.sim.snapshot(this.ring[slot]!) }
  }

  /** The last `count` inputs for a local player, for the redundancy every message carries. */
  localRun(player: number, count: number): { from: At; f: number[] } {
    const end = this.lastReal[player]!
    const from = Math.max(0, end - count + 1)
    const f: number[] = []
    for (let t = from; t <= end; t++) f.push(this.real[player]!.get(t) ?? this.lastValue[player]!)
    return { from, f }
  }

  private remoteLead(): At {
    let lead = -1
    for (let p = 0; p < this.opts.players; p++) {
      if (this.opts.localPlayers.includes(p)) continue
      if (!this.sim.holds(this.state, p)) continue
      if (this.lastReal[p]! > lead) lead = this.lastReal[p]!
    }
    return lead
  }

  /** True when we are too far ahead of a peer and must wait for them. */
  private shouldStall(): boolean {
    for (let p = 0; p < this.opts.players; p++) {
      if (this.opts.localPlayers.includes(p)) continue
      // A place the computer is driving is not one to wait for. Without this
      // the handover changes nothing: the room hands it over and every peer
      // goes on stopping for input that is never coming and is no longer
      // wanted.
      if (!this.sim.holds(this.state, p)) continue
      if (this.at - this.lastReal[p]! > this.opts.window) return true
    }
    return false
  }

  /**
   * Catch up with wall-clock time. `sample` is called once per point to read
   * the local controls, and should call `setLocalInput`.
   */
  advance(dtMs: number, sample: (player: number, at: At) => void): void {
    this.acc += dtMs
    // A long stall — a tab in the background — must not trigger a replay storm.
    if (this.acc > this.opts.tickMs * 12) this.acc = this.opts.tickMs * 12

    this.stalled = false
    while (this.acc >= this.opts.tickMs) {
      if (this.shouldStall()) {
        this.stalled = true
        break
      }
      this.acc -= this.opts.tickMs
      this.sim.copy(this.prev, this.state)
      for (const p of this.opts.localPlayers) sample(p, this.at)
      this.stepOnce()
      this.prune()
    }

    // And the other direction, which real time cannot fix on its own. A frame
    // gives every machine one point, so two machines a hundred apart stay a
    // hundred apart however long they both play. Somebody who arrives late
    // arrives behind by however long their replay took, and without this they
    // go on being called late by a room that has already given their place
    // away.
    let extra = this.opts.catchupPerFrame
    while (extra > 0 && this.remoteLead() - this.at > this.opts.catchupSlack) {
      if (this.shouldStall()) {
        this.stalled = true
        break
      }
      extra--
      this.sim.copy(this.prev, this.state)
      for (const p of this.opts.localPlayers) sample(p, this.at)
      this.stepOnce()
      this.prune()
    }
  }

  /**
   * Play a match forward through inputs somebody else already made.
   *
   * How a latecomer arrives in a game that is going. The same thing a rewind
   * does — copy a state, step it — with a longer run and nothing to correct
   * afterwards, and fed as real input so the watermarks and the fingerprints
   * land where they would have had this machine been here all along.
   */
  catchUp(
    log: number[][],
    to: At,
    handovers: readonly Handover[] = [],
    /**
     * Where the log begins, and the world to begin from.
     *
     * Adopted at construction and never afterwards. A world put into a session
     * already running has to have the rewind bookkeeping rebuilt around points
     * it never played, and something in that is never quite what a client which
     * did play them holds.
     */
    origin?: { at: At; data: readonly number[] } | null,
  ): void {
    const from = origin?.at ?? 0
    if (origin != null) {
      if (!this.sim.restore(this.state, origin.data)) return
      for (let i = 0; i < this.ringSize; i++) this.ringAt[i] = -1
      this.sim.copy(this.prev, this.state)
    }
    // Sorted because the points are not in order — each is measured from its
    // own player's last input, so one for somebody lagging can name an earlier
    // point than one sent before it. Ties keep the order they were sent in,
    // which a stable sort guarantees and which matters: a place taken and
    // given back on the same point is not the same as the other way round.
    const order = [...handovers].sort((a, b) => a.at - b.at)
    const keep = Math.max(from, to - this.ringSize + 1)
    this.bulkLog = log
    this.bulkKeep = keep
    this.bulkFrom = from
    let i = 0
    // Decisions already baked into the world we restored are not replayed:
    // re-applying them from a point we are past would be re-deciding a question
    // the state already answers.
    while (i < order.length && order[i]!.at < this.at) i++
    while (this.at <= to) {
      while (i < order.length && order[i]!.at <= this.at) {
        const h = order[i]!
        this.autoFrom.set(h.p, { at: h.at, on: h.on })
        if (h.on) this.water.released(h.p, h.at)
        else this.water.reclaimed(h.p, h.at)
        i++
      }
      this.stepOnce()
    }
    this.bulkLog = null
    this.bulkKeep = -1
    this.bulkFrom = 0
    // Any still ahead of us were scheduled before we got here, so the broadcast
    // that announced them is one we were never going to hear.
    for (; i < order.length; i++) {
      const h = order[i]!
      this.autoFrom.set(h.p, { at: h.at, on: h.on })
      if (h.on) this.water.released(h.p, h.at)
      else this.water.reclaimed(h.p, h.at)
    }
    for (let p = 0; p < log.length && p < this.opts.players; p++) {
      const row = log[p]!
      for (let t = keep; t <= to && t - from < row.length; t++) this.real[p]!.set(t, row[t - from]!)
      this.lastReal[p] = to
      this.lastValue[p] = row[to - from] ?? this.lastValue[p]!
    }
    // Nothing that happened before we walked in gets announced. Without this a
    // latecomer arrives to every event of the match at once, because the whole
    // match's events are still sitting in the mask waiting to be drained.
    this.eventsThrough = to
    this.pendingEvents = 0
    this.acc = 0
  }

  /**
   * Forget what nothing can reach again.
   *
   * Three different answers, which is why doing it with one number was wrong.
   * What we stepped with is only ever read by a rewind, so the ring bounds it.
   * What players really sent is also walked by the watermark, which is behind
   * the ring whenever somebody is lagging, so it is bounded by the confirmed
   * line as well. Fingerprints are read in order and never again, so whatever
   * is behind the next one to report is dead.
   *
   * Getting this wrong is invisible. The version this was taken from floored
   * the cutoff with an array that was initialised to -1 and never written, so
   * the cutoff collapsed to zero and it deleted nothing for the life of the
   * match — measured at three thousand entries per player per map, against a
   * ring of forty-two.
   */
  private prune(): void {
    if (this.at % 120 !== 0) return
    const ring = this.at - this.ringSize
    if (ring <= 0) return
    const keepReal = Math.min(ring, this.confirmed())
    for (let p = 0; p < this.opts.players; p++) {
      for (const k of this.real[p]!.keys()) if (k < keepReal) this.real[p]!.delete(k)
      for (const k of this.used[p]!.keys()) if (k < ring) this.used[p]!.delete(k)
    }
    for (const k of this.hashAt.keys()) if (k < this.nextHash) this.hashAt.delete(k)
  }
}
