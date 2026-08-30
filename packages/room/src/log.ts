// Everything the players have sent, by player and by point on the timeline.
//
// A room that never simulates can still hold the whole game, because a
// deterministic simulation plus its inputs *is* the game. Replaying the log
// from the origin is how a latecomer arrives, how a broken client is repaired,
// and how a saved match is loaded — one mechanism doing three jobs, which is
// why it is worth having as its own thing rather than three.
//
// The contributions themselves are opaque. This is a packed input frame in six
// of the games it was taken from and a list of unit orders in another; neither
// is any of the room's business.

/**
 * A point on whatever timeline the game runs on.
 *
 * A tick, a bundle index, a turn number. Always an integer, always going
 * forwards; what it *means* is the clock's business and never this file's.
 */
export type At = number

export interface LogOptions {
  /** How many players may contribute. Rows outside this are refused. */
  readonly players: number
  /** The first point the log covers. Usually zero; not always — see compaction. */
  readonly origin?: At
}

export class ContributionLog<C = number> {
  readonly origin: At
  private readonly players: number
  private readonly rows: (C | undefined)[][] = []
  /** The newest point anybody has spoken for, or origin - 1 when nobody has. */
  private newest: At
  /** The newest point each player has spoken for. */
  private readonly last: At[] = []

  constructor(opts: LogOptions) {
    this.players = opts.players
    this.origin = opts.origin ?? 0
    this.newest = this.origin - 1
    for (let p = 0; p < this.players; p++) {
      this.rows.push([])
      this.last.push(this.origin - 1)
    }
  }

  /** The newest point anybody has spoken for. `origin - 1` on an empty log. */
  get head(): At {
    return this.newest
  }

  /** The newest point one player has spoken for. */
  lastFrom(player: number): At {
    return this.last[player] ?? this.origin - 1
  }

  /**
   * Record a run of contributions from one player, oldest first.
   *
   * Runs overlap on purpose — every message carries the last couple of dozen
   * so a lost packet heals itself — so re-recording what is already held is
   * the ordinary case and must be free of consequence.
   *
   * Returns false for a player outside the roster or a point before the
   * origin, so a caller can tell a malformed message from a redundant one.
   */
  record(player: number, from: At, run: readonly C[]): boolean {
    if (!Number.isInteger(player) || player < 0 || player >= this.players) return false
    if (!Number.isInteger(from) || from < this.origin) return false
    const row = this.rows[player]!
    for (let i = 0; i < run.length; i++) row[from + i - this.origin] = run[i]
    const end = from + run.length - 1
    if (end > this.newest) this.newest = end
    if (end > this.last[player]!) this.last[player] = end
    return true
  }

  /**
   * The whole log, as a rectangle with no holes, for handing to a newcomer.
   *
   * A point a player never spoke for is one they repeated themselves on, which
   * is what a client does with a gap anyway and saves the far end guessing.
   *
   * Every row, not only the players who were there at the start: somebody who
   * joined after the drop has a row here too, and leaving it out is how the
   * third person to walk into a game ends up in a different one from everybody
   * else — they replay it with the second person's entity never having moved.
   */
  rectangle(fill: C): C[][] {
    const span = this.newest - this.origin + 1
    const out: C[][] = []
    for (let p = 0; p < this.players; p++) {
      const row = this.rows[p]!
      const flat = new Array<C>(Math.max(0, span))
      let last = fill
      for (let i = 0; i < span; i++) flat[i] = last = row[i] ?? last
      out.push(flat)
    }
    return out
  }

  /**
   * Move the origin forward, discarding what nobody can ask for again.
   *
   * The counterpart to an origin that is a state rather than a seed: once a
   * snapshot at `to` exists, everything before it is re-derivable from it and
   * costs only memory. Without this an unbounded game grows without bound.
   */
  compact(to: At): void {
    if (to <= this.origin) return
    const drop = to - this.origin
    for (let p = 0; p < this.players; p++) this.rows[p] = this.rows[p]!.slice(drop)
    ;(this as { origin: At }).origin = to
    if (this.newest < to - 1) this.newest = to - 1
    for (let p = 0; p < this.players; p++) {
      if (this.last[p]! < to - 1) this.last[p] = to - 1
    }
  }

  /** Forget everything. A room being recycled for a fresh game. */
  clear(): void {
    for (let p = 0; p < this.players; p++) {
      this.rows[p] = []
      this.last[p] = this.origin - 1
    }
    this.newest = this.origin - 1
  }
}
