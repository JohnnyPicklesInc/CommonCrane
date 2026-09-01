// The other side of an authority: holding a world somebody else is simulating.
//
// Two clocks, and keeping them apart is the whole of it.
//
// What you are told is the truth, and it arrives late and in steps. Rendering
// it directly is the classic mistake: frames land at the authority's rate, not
// the screen's, so everything moves in jerks. So the truth is kept in a short
// buffer and rendered a fixed time behind the newest of it, which leaves two
// worlds either side of the moment being drawn and something to blend between.
//
// Your own player cannot wait for that. A control that answers a round trip
// late is a control that feels broken, however correct it is. So local input
// is applied immediately to a predicted world, and when the truth catches up
// the prediction is rebuilt from it: restore the world the authority described,
// then re-apply everything you have done since.
//
// Everybody else is not predicted, and cannot be. A client receiving worlds
// never learns anybody's *input* — only what their input did — so there is
// nothing to carry forward for them. That is why they are interpolated and you
// are predicted, and why the two are different states here rather than one.
//
// What to draw out of those two is the game's: which parts of a world are
// continuous enough to blend, and which player's part to take from where.

import type { At } from './log.ts'
import type { Sim } from './rollback.ts'
import { receive, type Frame } from './authority.ts'

export interface FollowerOptions<State> {
  readonly sim: Sim<State>
  readonly players: number
  /** Wall-clock milliseconds per point. */
  readonly tickMs: number
  /** The packed input meaning "nothing". */
  readonly idle: number
  /** Which places this machine speaks for. */
  readonly localPlayers: number[]
  /**
   * How far behind the newest truth to draw, in milliseconds.
   *
   * The buffer this buys is what keeps the picture smooth: below one point's
   * worth there is frequently nothing to blend towards and everything stops
   * dead until the next frame. Above that it is a straight trade of lateness
   * for tolerance of an uneven connection.
   */
  readonly delayMs?: number
  /** How many worlds to keep for blending between. */
  readonly keep?: number
}

/** Two worlds and how far between them the moment being drawn falls. */
export interface Between {
  readonly a: number[]
  readonly b: number[]
  /** 0 at `a`, 1 at `b`. */
  readonly alpha: number
}

export class Follower<State> {
  /**
   * The world as this machine believes it is *now*.
   *
   * Rebuilt from the newest truth and run forward with local input, so it is
   * right about the local player and only a guess about everybody else. Use it
   * for what the local player is doing and touching; do not draw anybody else
   * out of it.
   */
  readonly state: State
  private readonly opts: FollowerOptions<State>
  private readonly sim: Sim<State>
  private readonly read: (s: State, d: readonly number[]) => boolean
  /** The newest world the authority has described, as numbers. */
  private world: number[] = []
  private truth: At = -1
  /** Recent truths and when each arrived, for blending between. */
  private readonly seen: { at: At; world: number[]; when: number }[] = []
  /** What this machine has done and the authority has not yet accounted for. */
  private readonly mine: Map<At, number>[] = []
  private readonly lastMine: number[] = []
  private lastSent: At[] = []
  private acc = 0
  private clock = 0

  constructor(opts: FollowerOptions<State>) {
    this.opts = opts
    this.sim = opts.sim
    const read = opts.sim.restore
    if (read === undefined) {
      // Not optional here: being told the world *is* the protocol, so a game
      // that cannot read one back has nothing to follow.
      throw new Error('a follower needs a sim that can read a state back')
    }
    this.read = read
    this.state = this.sim.create()
    for (let p = 0; p < opts.players; p++) {
      this.mine.push(new Map())
      this.lastMine.push(opts.idle)
      this.lastSent.push(-1)
    }
  }

  get at(): At {
    return this.sim.pointOf(this.state)
  }

  /** The newest point the authority has described. */
  get confirmed(): At {
    return this.truth
  }

  /**
   * Take a frame.
   *
   * False when it cannot be applied — a difference against a world this is not
   * holding. The answer to that is to ask for a whole one, which is the
   * caller's to do because only it can speak to the authority.
   */
  take(frame: Frame, now: number): boolean {
    if (!receive(this.world, frame, this.truth)) return false
    this.truth = frame.at
    this.seen.push({ at: frame.at, world: [...this.world], when: now })
    const keep = this.opts.keep ?? 8
    while (this.seen.length > keep) this.seen.shift()
    // Everything the authority has now accounted for is no longer ours to
    // re-apply. Kept until then, because until then it is the only record of
    // what we did between its world and ours.
    for (let p = 0; p < this.opts.players; p++) {
      for (const k of this.mine[p]!.keys()) if (k < frame.at) this.mine[p]!.delete(k)
    }
    this.rebuild()
    return true
  }

  /**
   * Put the prediction back on the truth, then run it forward again.
   *
   * The correction is invisible when the prediction was right, which it
   * usually is: the same inputs through the same simulation from the same
   * world land in the same place. It shows when it was wrong, which is what
   * being wrong should look like.
   */
  private rebuild(): void {
    if (!this.read(this.state, this.world)) return
    const to = this.furthest()
    while (this.at <= to) this.step()
  }

  /** The newest point we have said anything for. */
  private furthest(): At {
    let to = this.truth
    for (const p of this.opts.localPlayers) {
      for (const k of this.mine[p]!.keys()) if (k > to) to = k
    }
    return to
  }

  private step(): void {
    const t = this.at
    const inputs = new Array<number>(this.opts.players)
    for (let p = 0; p < this.opts.players; p++) {
      const said = this.mine[p]!.get(t)
      if (said !== undefined) this.lastMine[p] = said
      // Only our own is known. Everybody else carries on with whatever the
      // world already has them doing, which is wrong and does not matter:
      // nobody else is drawn out of this state.
      inputs[p] = this.opts.localPlayers.includes(p) ? this.lastMine[p]! : this.opts.idle
    }
    this.sim.step(this.state, inputs)
  }

  /** Record what this machine is doing. */
  setLocalInput(player: number, at: At, packed: number): void {
    if (!this.opts.localPlayers.includes(player)) return
    this.mine[player]!.set(at, packed)
    if (at > this.lastSent[player]!) this.lastSent[player] = at
  }

  /** The most recent local inputs, for sending with redundancy. */
  localRun(player: number, count: number): { from: At; f: number[] } {
    const end = this.lastSent[player]!
    const from = Math.max(0, end - count + 1)
    const f: number[] = []
    for (let t = from; t <= end; t++) f.push(this.mine[player]!.get(t) ?? this.lastMine[player]!)
    return { from, f }
  }

  /**
   * Catch up with wall-clock time, sampling local controls once per point.
   *
   * Nothing here waits for anybody. That is the whole difference from a
   * rollback: there is no peer to be too far ahead of, because no peer is
   * being simulated.
   */
  advance(dtMs: number, sample: (player: number, at: At) => void): void {
    this.clock += dtMs
    this.acc += dtMs
    // A long pause must not turn into a burst of simulation nobody watched.
    if (this.acc > this.opts.tickMs * 12) this.acc = this.opts.tickMs * 12
    while (this.acc >= this.opts.tickMs) {
      this.acc -= this.opts.tickMs
      for (const p of this.opts.localPlayers) sample(p, this.at)
      this.step()
    }
  }

  /**
   * The two worlds to draw between, and how far between them we are.
   *
   * Null when there is not yet enough truth to blend — the first moments of a
   * match, or after a gap long enough to empty the buffer. Drawing the newest
   * world on its own is the right answer to that, and it is the caller's.
   */
  between(now: number): Between | null {
    if (this.seen.length < 2) return null
    const target = now - (this.opts.delayMs ?? this.opts.tickMs * 2)
    let a = this.seen[0]!
    let b = this.seen[1]!
    for (let i = 1; i < this.seen.length; i++) {
      if (this.seen[i]!.when <= target) {
        a = this.seen[i]!
        b = this.seen[Math.min(i + 1, this.seen.length - 1)]!
      }
    }
    if (b === a) return { a: a.world, b: a.world, alpha: 0 }
    const span = b.when - a.when
    const alpha = span <= 0 ? 0 : Math.min(1, Math.max(0, (target - a.when) / span))
    return { a: a.world, b: b.world, alpha }
  }

  /** The newest world as numbers, for when there is nothing to blend. */
  newest(): number[] {
    return this.world
  }
}
