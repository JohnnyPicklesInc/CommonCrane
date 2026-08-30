// Questions about who is in the room.
//
// Functions rather than a container, and that was learned rather than chosen.
// A room whose memory can be lost while its connections outlive it has to keep
// the membership on the connections themselves — which means a library object
// holding it would be holding a copy, rebuilt on every read and thrown away.
// Written that way it cost thirteen lines of unpacking to save nine of asking.
//
// The questions are the part that is duplicated. Every game already has its own
// record of who is here, in whatever shape its host makes cheap; none of them
// needs a second one. So these take that record as it is and answer.
//
// A chair is a place in the room. A place in the *match* is a different number,
// and confusing the two has crashed a game in this family — see `Match`.

/** As much of a game's own record as these questions need. */
export interface Seated<Seat = unknown> {
  /** Chairs this connection holds. One each, usually; several for a couch. */
  readonly chairs: readonly number[]
  readonly name: string
  /** The game's blob per chair — a side, a bike, a weapon. Never read here. */
  readonly seats?: readonly (Seat | undefined)[]
}

/** Chairs nobody holds, ascending. */
export function freeChairs(seated: Iterable<Seated>, capacity: number): number[] {
  const taken = new Set<number>()
  for (const s of seated) for (const c of s.chairs) taken.add(c)
  const out: number[] = []
  for (let i = 0; i < capacity; i++) if (!taken.has(i)) out.push(i)
  return out
}

/**
 * Which chair holds the start button: the lowest one in the room.
 *
 * Lowest rather than "whoever opened it", so a room whose opener has left still
 * has somebody able to start it — and the handover happens on its own, with
 * nothing to elect and nothing to announce. -1 when the room is empty.
 *
 * Pass the room without somebody in it to ask as though they had already gone,
 * which is the moment a connection is closing but the host still lists it.
 */
export function hostChair(seated: Iterable<Seated>): number {
  let low = -1
  for (const s of seated) {
    const first = [...s.chairs].sort((a, b) => a - b)[0]
    if (first === undefined) continue
    if (low < 0 || first < low) low = first
  }
  return low
}

/**
 * The room as everybody in it sees it: a name per chair and the game's own blob
 * per chair, with gaps as null.
 *
 * This is every lobby message in this family once the blob is left alone — the
 * five that looked different differed only in what they called it.
 *
 * `name` is asked per chair rather than taken from the record, because the extra
 * people on one machine are numbered off the first: nobody setting up four
 * controllers is going to type four names.
 */
export function roster<Seat>(
  seated: Iterable<Seated<Seat>>,
  capacity: number,
  name: (s: Seated<Seat>, index: number) => string,
): { names: (string | null)[]; seats: (Seat | null)[] } {
  const names = new Array<string | null>(capacity).fill(null)
  const seats = new Array<Seat | null>(capacity).fill(null)
  for (const s of seated) {
    for (let i = 0; i < s.chairs.length; i++) {
      const c = s.chairs[i]!
      if (c < 0 || c >= capacity) continue
      names[c] = name(s, i)
      seats[c] = s.seats?.[i] ?? null
    }
  }
  return { names, seats }
}

/**
 * How many chairs somebody should end up with, having asked for `want`.
 *
 * Giving them back is always allowed; taking them is limited by what is going
 * spare, so asking for six in a room where two are gone quietly gets you four
 * rather than failing. A room that refused would be one where somebody's couch
 * seats fewer people than are sitting on it, with nothing said about it.
 */
export function resizeChairs(
  held: readonly number[],
  want: number,
  free: readonly number[],
): number[] {
  const keep = Math.max(1, want)
  if (keep <= held.length) return [...held].sort((a, b) => a - b).slice(0, keep)
  return [...held, ...free.slice(0, keep - held.length)].sort((a, b) => a - b)
}
