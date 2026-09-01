// The other deterministic layer: one machine simulates, everybody else watches.
//
// Where `Rollback` has every client simulate every player and rewind when a
// guess is contradicted, this has exactly one simulate and send out what
// happened. The trade is the whole design:
//
//   Rollback costs N clients each simulating N players, every point, again for
//   every rewind — and it stops dead whenever any one peer falls more than a
//   window behind, because the wait is a maximum over peers rather than an
//   average. That is why it does not go past a handful of people.
//
//   This costs one simulation and N sends. Nobody waits for anybody. It scales
//   with the room rather than with its square, and because only one machine
//   computes anything, the simulation no longer has to be deterministic — which
//   is what a game pays for rollback in trigonometry it cannot use.
//
// What it gives up is that somebody is now in charge. Where that somebody is a
// player, they see everything and can do anything; where it is a server you
// run, they cannot, and you are paying for the server. Neither is this
// module's business — it simulates and describes, and does not know what it is
// running on.
//
// Nothing here is a message. Frames come out; sending them is the caller's.

import type { At } from './log.ts'
import type { Sim } from './rollback.ts'

export interface AuthorityOptions<State> {
  readonly sim: Sim<State>
  /** Places the match is laid out for. */
  readonly players: number
  /** Wall-clock milliseconds per point. */
  readonly tickMs: number
  /** The packed input meaning "nothing", used before anybody has spoken. */
  readonly idle: number
  /**
   * How many past points a frame may be measured against.
   *
   * A client that has not confirmed anything inside this gets the whole world
   * instead of a difference. Bigger costs memory and buys tolerance of a bad
   * connection; there is no correctness in it either way.
   */
  readonly remember?: number
  /**
   * A world to carry on from, rather than a fresh one.
   *
   * For taking over: whoever was simulating has gone, and the match has to
   * continue from where they left it rather than from the beginning. Refused
   * if it is not a world this simulation recognises, which leaves a fresh one —
   * wrong, but wrong in a way somebody can see, rather than a state half
   * filled in from somebody else's build.
   */
  readonly from?: readonly number[]
}

/**
 * What one client is owed: the world, or how it has changed since a point they
 * already have.
 *
 * `from` of -1 means the whole thing, and a client with nothing has to be sent
 * one of those before a difference can mean anything. Otherwise `data` is
 * index-and-value pairs against the world at `from`.
 */
export interface Frame {
  readonly at: At
  readonly from: At
  readonly data: number[]
}

export class Authority<State> {
  readonly state: State
  private readonly opts: AuthorityOptions<State>
  private readonly sim: Sim<State>
  private readonly write: (s: State) => number[]
  /**
   * Recent worlds, written down rather than kept as states.
   *
   * This never rewinds, so past *states* are of no use to it — only past
   * descriptions, to measure a difference against. One array each rather than
   * one state each is a great deal less to hold.
   */
  private readonly past: (number[] | null)[]
  /** What each player has said they hold. */
  private readonly confirmed: At[] = []
  /** What each player has told us, by point. */
  private readonly said: Map<At, number>[] = []
  private readonly lastSaid: number[] = []
  private acc = 0

  constructor(opts: AuthorityOptions<State>) {
    this.opts = opts
    this.sim = opts.sim
    const write = opts.sim.snapshot
    if (write === undefined) {
      // Not optional here, unlike in a rollback: describing the world *is* the
      // protocol, so a game that cannot write one down has nothing to send.
      throw new Error('an authority needs a sim that can write its state down')
    }
    this.write = write
    this.past = new Array<number[] | null>(opts.remember ?? 64).fill(null)
    this.state = this.sim.create()
    if (opts.from !== undefined) opts.sim.restore?.(this.state, opts.from)
    for (let p = 0; p < opts.players; p++) {
      this.confirmed.push(-1)
      this.said.push(new Map())
      this.lastSaid.push(opts.idle)
    }
    this.remember()
  }

  get at(): At {
    return this.sim.pointOf(this.state)
  }

  /** A fingerprint of the world, for anybody who wants to check theirs. */
  hash(): number {
    return this.sim.hash(this.state)
  }

  /** What somebody says they are doing, from `from` onwards. */
  input(player: number, from: At, run: readonly number[]): void {
    if (player < 0 || player >= this.opts.players) return
    if (!Number.isInteger(from) || from < 0) return
    const mine = this.said[player]!
    for (let i = 0; i < run.length; i++) {
      const at = from + i
      // Nothing behind the present: the world at that point is already written
      // down and sent, and rewriting history is what this design exists to
      // avoid having to do.
      if (at < this.at) continue
      mine.set(at, run[i]!)
    }
  }

  /** A client says it holds the world as of this point. */
  holds(player: number, at: At): void {
    if (player < 0 || player >= this.opts.players) return
    if (at > this.confirmed[player]!) this.confirmed[player] = at
  }

  /**
   * Catch up with wall-clock time.
   *
   * Returns how many points were played, so a caller can tell a busy tick from
   * a quiet one without asking twice.
   */
  advance(dtMs: number): number {
    this.acc += dtMs
    // A long pause — a tab in the background, a machine asleep — must not turn
    // into a burst of simulation nobody watched.
    if (this.acc > this.opts.tickMs * 12) this.acc = this.opts.tickMs * 12
    let played = 0
    while (this.acc >= this.opts.tickMs) {
      this.acc -= this.opts.tickMs
      this.step()
      played++
    }
    return played
  }

  private step(): void {
    const t = this.at
    const inputs = new Array<number>(this.opts.players)
    for (let p = 0; p < this.opts.players; p++) {
      const said = this.said[p]!.get(t)
      // Nothing from them for this point means they have not spoken yet, and
      // the best guess is that they are still doing whatever they were. That
      // is the same rule a rollback predicts with — the difference is that here
      // it is never corrected, because this world is the only one there is.
      if (said !== undefined) this.lastSaid[p] = said
      inputs[p] = this.lastSaid[p]!
      this.said[p]!.delete(t)
    }
    this.sim.step(this.state, inputs)
    this.remember()
  }

  private remember(): void {
    const t = this.at
    this.past[((t % this.past.length) + this.past.length) % this.past.length] = this.write(
      this.state,
    )
  }

  /** The world as it was at `at`, or null if it is no longer remembered. */
  private worldAt(at: At): number[] | null {
    if (at < 0 || at > this.at || this.at - at >= this.past.length) return null
    return this.past[((at % this.past.length) + this.past.length) % this.past.length] ?? null
  }

  /**
   * What this player is owed.
   *
   * A difference against the newest point they have confirmed, or the whole
   * world when they have confirmed nothing recent enough to measure against.
   * Falling back to the whole world rather than refusing is what makes a bad
   * connection slow rather than broken.
   */
  frame(player: number): Frame {
    const now = this.worldAt(this.at)!
    const base = player >= 0 && player < this.opts.players ? this.confirmed[player]! : -1
    const was = base === this.at ? null : this.worldAt(base)
    if (was === null || was.length !== now.length) {
      return { at: this.at, from: -1, data: [...now] }
    }
    const data: number[] = []
    for (let i = 0; i < now.length; i++) {
      if (now[i] !== was[i]) data.push(i, now[i]!)
    }
    return { at: this.at, from: base, data }
  }
}

/**
 * Build the world a frame describes, from the one it was measured against.
 *
 * `base` must be the world at `frame.from` and nothing else — not simply the
 * newest one held. Those are different worlds whenever a frame is in flight,
 * which is most of the time: the authority measures against what a player last
 * *said* it held, and by the time that reaches it the player has moved on. A
 * difference applied to the wrong world produces one nobody else has, which
 * looks plausible and diverges in silence.
 *
 * Null when it cannot be built, which is the caller's cue to ask for a whole
 * one rather than to carry on.
 */
export function apply(base: readonly number[] | null, frame: Frame): number[] | null {
  if (frame.from === -1) return [...frame.data]
  if (base === null) return null
  const out = [...base]
  for (let i = 0; i + 1 < frame.data.length; i += 2) {
    const k = frame.data[i]!
    if (k < 0 || k >= out.length) return null
    out[k] = frame.data[i + 1]!
  }
  return out
}
