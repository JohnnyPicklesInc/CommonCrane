// When a decision takes effect.
//
// This is the only place a room has an opinion about time, and it is the one
// function that has to be right. A decision is a fact about a *point*, not
// about the moment somebody decided it: every client has to apply it at the
// same point or they are playing different games.
//
// Dated too near and it lands behind a client's horizon — the client rewinds to
// reach it, runs off the end of whatever history it keeps, and gives up. That
// failure is silent on both sides: the room is certain somebody is playing
// while they are still watching, and nothing anywhere says so. Measured once at
// a handover dated to point 17 with the room's head at 233.

import type { At } from './log.ts'

/** What the clock is allowed to know when it picks a point. */
export interface ClockView {
  /** The newest point anybody has spoken for. */
  readonly head: At
  /** The newest point one player has spoken for, or head - 1 if never. */
  lastFrom(player: number): At
  /** Whether this player's place is currently driven by something automatic. */
  isAutomatic(player: number): boolean
}

export interface Clock {
  /** The first point of the timeline. */
  readonly origin: At
  /**
   * The nearest point in the future every participant can still reach.
   *
   * `player` is who the decision is about, when it is about somebody in
   * particular — the answer differs, and the difference is the bug above.
   */
  schedule(view: ClockView, player?: number): At
}

export interface RollbackClockOptions {
  /**
   * How far a client may run ahead of the newest input it holds from a peer.
   *
   * A decision must land inside this, measured from the right place, or it
   * cannot be reached.
   */
  readonly window: number
  /** A little more, for the trip. */
  readonly slack?: number
  readonly origin?: At
}

/**
 * The clock for a game where clients predict and rewind.
 *
 * Two anchors, and picking the wrong one is the whole hazard:
 *
 * For somebody still sending, the point is measured off *their* last
 * contribution, because their peers stall relative to that. Measured off the
 * room's own head instead it lands past the last point anybody can reach —
 * every peer is stalled a window past this player, so a date beyond that is a
 * date nobody arrives at, and the wait never ends.
 *
 * For a place already driven by something automatic there is nobody to wait
 * for, so it is measured off the head. Anchoring on that player's last
 * contribution would anchor on something minutes old, which is worse than too
 * far ahead: a point that far back is one a client rewinds to, fails to reach,
 * and abandons.
 */
export function rollbackClock(opts: RollbackClockOptions): Clock {
  const ahead = opts.window + (opts.slack ?? 4)
  const origin = opts.origin ?? 0
  return {
    origin,
    schedule(view, player) {
      if (player === undefined || view.isAutomatic(player)) return view.head + ahead
      return view.lastFrom(player) + ahead
    },
  }
}

/**
 * The clock for a game whose server emits the timeline itself.
 *
 * Nobody predicts, so there is no horizon to stay inside and no per-player
 * anchor: the next point the server has not yet sent is reachable by
 * definition.
 */
export function streamClock(opts: { origin?: At } = {}): Clock {
  const origin = opts.origin ?? 0
  return { origin, schedule: (view) => view.head + 1 }
}

/**
 * Every decision this game has taken, oldest first, each dated to a point.
 *
 * Recorded as well as sent, which is the part that gets forgotten. A decision
 * that was only broadcast is invisible until somebody joins and has to replay
 * the game to get here — and a replay that does not know who was driving
 * produces a different game from the one everybody else is in. One of the
 * games this came from sent handovers from three places and recorded them from
 * none.
 */
export class DecisionLog<D> {
  private readonly entries: { seq: number; at: At; body: D }[] = []
  private next = 0

  /** Date a decision and record it. The returned entry is what to broadcast. */
  add(at: At, body: D): { seq: number; at: At; body: D } {
    const e = { seq: this.next++, at, body }
    this.entries.push(e)
    return e
  }

  /** Everything decided, in the order it was decided. */
  all(): readonly { seq: number; at: At; body: D }[] {
    return this.entries
  }

  get length(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries.length = 0
    this.next = 0
  }
}
