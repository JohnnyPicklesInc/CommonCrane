// What to show somebody looking for a room to join.
//
// The list is a cache of something the rooms own, never the truth. A room that
// is evicted, crashes or loses power leaves its entry behind with no way to
// retract it — so every entry carries when it was last confirmed, and anything
// stale is dropped on the way out. The cost of being wrong is one click on a
// room that has gone, which the door reports properly.
//
// The storage is the host's. What is here is the deciding: what has gone stale,
// what is worth offering, and in what order.

export interface Listed {
  readonly code: string
  /** What the host calls themselves. Another player's input — see `Arrival`. */
  readonly host: string
  readonly players: number
  readonly max: number
  /** When the room opened, for ordering. */
  readonly since: number
  /** Whether a match is under way, rather than a lobby waiting. */
  readonly live?: boolean
  /** The build this room plays. */
  readonly build: string
  /** When the room last confirmed it was still there. */
  readonly updated: number
}

/** A room as somebody browsing sees it. */
export type Offer = Omit<Listed, 'build' | 'updated'> & { readonly live: boolean }

export interface SiftOptions {
  /** Only rooms on this build. */
  readonly build: string
  readonly now: number
  /**
   * How long an entry outlives its last confirmation.
   *
   * Must be comfortably more than the interval rooms confirm on, or an
   * ordinary open room falls off the list for being briefly quiet — and the
   * most common room in existence, one person waiting for a second, is the
   * one that goes first.
   */
  readonly staleMs: number
}

/**
 * Split what is stored into what to offer and what to throw away.
 *
 * Both at once, because reading is the only traffic a list like this reliably
 * gets and so the only dependable moment to take the rubbish out.
 *
 * Filtered by build here rather than by whoever is browsing: a room seats only
 * clients running its own bundle, so an entry on another build is not a game
 * somebody can join, it is a dead link that looks like one. Staleness is
 * decided first, so a dead entry on another build is still collected rather
 * than left to sit there for ever.
 */
export function sift(
  entries: Iterable<readonly [string, Listed]>,
  opts: SiftOptions,
): { offers: Offer[]; expired: string[] } {
  const cutoff = opts.now - opts.staleMs
  const offers: Offer[] = []
  const expired: string[] = []
  for (const [key, e] of entries) {
    // Missing rather than old: an entry with no confirmation time at all cannot
    // be shown to have been confirmed, and treating it as fresh is how one
    // stays on the list for ever. A comparison against `undefined` is false,
    // which is exactly the wrong way round.
    if (typeof e.updated !== 'number' || e.updated < cutoff) {
      expired.push(key)
      continue
    }
    if (e.build !== opts.build) continue
    offers.push({
      code: e.code,
      host: e.host,
      players: e.players,
      max: e.max,
      since: e.since,
      // Entries written before rooms in play were listed at all have nothing
      // here, and those were all lobbies.
      live: e.live === true,
    })
  }
  offers.sort((a, b) => b.since - a.since)
  return { offers, expired }
}
