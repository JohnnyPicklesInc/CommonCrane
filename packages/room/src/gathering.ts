// Putting strangers who have no room code into the same room.
//
// The list in `listing.ts` answers "which rooms are open"; the door in
// `door.ts` answers "may this person come in". Between them there was nothing
// that answers "where is everybody going", which is what somebody who pressed
// a button marked *find me a game* is asking. Every game that has wanted it so
// far reached for the list — look at the open rooms, join one with space, open
// one when there are none — and that is wrong in exactly the case it exists
// for. Two people arrive at an empty list in the same moment, both find nothing,
// both open a room, and the two of them sit in separate lobbies waiting for
// each other. It fails only under load, which is to say only when it matters.
//
// The fix is not cleverness, it is a single place that answers. Both halves
// here are pure: what to do about a room somebody is holding, and what to do
// about a room filling up. Where that answer is kept, and what makes it
// single-threaded, is the host's — a Durable Object is one way and a row with a
// unique key is another, and neither is this library's business.

/** A room being handed out to whoever asks next. */
export interface Held {
  readonly code: string
  /** When it was first handed out. */
  readonly opened: number
}

export interface GatherOptions {
  readonly now: number
  /**
   * How long a room keeps being offered to new arrivals.
   *
   * A ceiling on how stale this can get, not a schedule. A room that starts, or
   * empties, says so and is dropped there and then, so in the ordinary case
   * this never expires. It covers the cases where nothing says so: a room that
   * was evicted, crashed, or filled up while the message was in flight. Being
   * wrong costs one arrival who finds a room that has gone, which the door
   * already reports properly.
   */
  readonly staleMs: number
  /** A fresh room code. `makeCode` unless a game numbers its rooms its own way. */
  readonly mint: () => string
}

/**
 * Where to send somebody looking for a game.
 *
 * `fresh` is the instruction to write it down. Returned rather than done here
 * because the writing is the host's, and because the caller has to know: a
 * fresh room is one nobody is in yet, and a game that opens its own doors
 * differently for the first arrival needs to be told which one this is.
 */
export function gather(held: Held | null, opts: GatherOptions): Held & { fresh: boolean } {
  if (held !== null && typeof held.opened === 'number' && opts.now - held.opened < opts.staleMs) {
    return { ...held, fresh: false }
  }
  return { code: opts.mint(), opened: opts.now, fresh: true }
}

export interface FillingOptions {
  /** How many are in the room now. */
  readonly here: number
  /**
   * The fewest worth starting for.
   *
   * Rarely one. A room that starts the moment somebody walks into it is a
   * single-player game with a queue in front of it, and most games already have
   * a door for that.
   */
  readonly least: number
  /** Every chair taken, after which nobody else is coming. */
  readonly most: number
  /** How long to keep looking once it could start. */
  readonly waitMs: number
  /**
   * How long a full room waits.
   *
   * Only enough notice to stop watching the horizon and look at the start line.
   * There is nothing left to wait for.
   */
  readonly fullMs: number
  /** When it is currently due to start, or 0 while it is not counting. */
  readonly startsAt: number
  readonly now: number
}

/**
 * When a room that is filling up should start, given what it said last time.
 *
 * Three rules, and every game that has written this by hand wrote all three:
 *
 *  - too few, and the clock stops rather than running out on somebody who would
 *    be dropped into a game on their own;
 *  - full, and it is brought forward — but never pushed back, because a clock
 *    that already says four seconds must not become six because somebody
 *    arrived;
 *  - otherwise it starts if it is not already running, and is left alone if it
 *    is. Restarting it on every arrival is a room that never starts at all
 *    while people keep trickling in.
 *
 * Returns the moment to start, or 0 for "not counting". Whether that moment has
 * arrived is the caller's comparison to make, on its own clock — this does not
 * decide, it schedules.
 */
export function filling(o: FillingOptions): number {
  if (o.here < o.least) return 0
  if (o.here >= o.most) {
    const soon = o.now + o.fullMs
    return o.startsAt === 0 || o.startsAt > soon ? soon : o.startsAt
  }
  return o.startsAt === 0 ? o.now + o.waitMs : o.startsAt
}

/**
 * Seconds until a room starts, for something to say on screen, or -1.
 *
 * Here rather than in each game because everybody who counts down displays one,
 * and rounding it in five places is five places that can disagree with the
 * moment the room actually goes.
 */
export function startsIn(startsAt: number, now: number): number {
  if (startsAt <= 0) return -1
  const left = Math.round((startsAt - now) / 1000)
  return left < 0 ? 0 : left
}
