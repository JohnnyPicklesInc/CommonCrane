// Who gets in, and as what.
//
// Four decisions, and they are decisions rather than plumbing — which is the
// test for whether something belongs here. One of them is a security rule that
// is easy to write once and easy to forget the second time.

/** What the door needs to know about the room to answer. */
export interface Doorway {
  /** Chairs nobody holds. Empty means full. */
  readonly free: readonly number[]
  /** Whether a match is running. */
  readonly started: boolean
  /**
   * A place a latecomer could take, or -1.
   *
   * Only meaningful while a match is running. -1 covers both "every place is
   * somebody's" and "this room has forgotten the match" — a room that cannot
   * describe a match to somebody has no business seating them in it.
   */
  readonly vacant: number
  /**
   * The build this room plays, or '' if nobody has set one.
   *
   * Empty means the room is new: whoever arrives first sets it.
   */
  readonly build: string
}

/** Somebody at the door. */
export interface Arrival {
  /**
   * A name somebody chose for themselves.
   *
   * Another player's input, and it travels: it reaches everybody else in the
   * room, the public list, and the replay of a match somebody joins an hour
   * later. Nothing here escapes it, because escaping depends on where it is
   * going — markup, a canvas, a log line — and that is the game's to know. It
   * *is* markup until it has been through something, and both a seat list and a
   * room list are usually built as strings.
   *
   * Bound its length at the door, where the room can still refuse.
   */
  readonly name: string
  /** What they are running. An empty string is a client too old to say. */
  readonly build: string
}

export type Admission =
  | { readonly as: 'play'; readonly chair: number; readonly opener: boolean }
  /**
   * In, but not playing — a match is already running and there is a place
   * being kept warm for them.
   *
   * They still get a chair: a watcher is in the room, is on the roster, and
   * takes a chair back with them when they ask to play. Withholding it only
   * made the caller work out the same answer a second time, which is how two
   * answers to one question get the chance to differ.
   */
  | { readonly as: 'watch'; readonly chair: number }
  | { readonly as: 'refuse'; readonly reason: string }

/**
 * Whether somebody may come in.
 *
 * `opener` on the way in is the security rule, and it is why this returns it
 * rather than leaving the caller to work it out. Whoever opens a room sets its
 * terms — the build everybody must match, and whether it is offered to the
 * public list — and those must be read from that arrival alone. Taken from
 * whoever happens to be asking, somebody joining a private room can put it on
 * the board over its owner's head.
 */
export function admit(door: Doorway, arriving: Arrival): Admission {
  const chair = door.free[0]
  if (chair === undefined) return { as: 'refuse', reason: 'This room is full.' }

  // A started room used to turn people away. It seats them to watch instead,
  // when there is a place being kept warm for somebody — which is the ordinary
  // case, because a match is laid out for the whole room from its first moment.
  if (door.started && door.vacant < 0) {
    return { as: 'refuse', reason: 'That game has already started.' }
  }

  // Everybody in a room has to be running the same build. Different builds
  // disagree about speeds, sizes and the order things happen in, so they come
  // apart on the first tick with nothing on screen to explain it.
  //
  // A client that reports no build at all is let in: only one old enough to
  // predate the question does that, and there is nothing to compare.
  const opener = door.build === ''
  if (!opener && arriving.build !== '' && arriving.build !== door.build) {
    return {
      as: 'refuse',
      reason:
        `You are on ${arriving.build} and this room is on ${door.build}. ` +
        'Reload the page to pick up the newest one.',
    }
  }

  if (door.started) return { as: 'watch', chair }
  return { as: 'play', chair, opener }
}
