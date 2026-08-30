// Who is in the room, and which chairs they hold.
//
// A chair is a place in the room; a place in the *match* is something else, and
// conflating the two has crashed a game in this family. See `Match` for the
// other one. Here we only care about the lobby: who has turned up, what they
// are called, and what they have asked for.
//
// One member may hold several chairs, because a machine with four people round
// it is indistinguishable from four machines to everybody else in the room. The
// one-chair case is the same code with a list of length one, which is worth
// having: written as a special case it is a second set of rules to keep in step
// with the first.
//
// Nothing here knows what a socket is. The caller supplies an id — whatever it
// uses to tell one connection from another — and gets back plain data.

/** Whatever the caller uses to tell one connection from another. */
export type MemberId = string

export interface Member<Seat> {
  readonly id: MemberId
  readonly name: string
  /** Chairs this member holds, ascending. */
  readonly chairs: readonly number[]
  /** The game's own blob per chair — a side, a bike, a weapon. Never read here. */
  readonly seats: readonly (Seat | undefined)[]
}

export interface MembersOptions {
  /** The most chairs the room has. */
  readonly capacity: number
}

export class Members<Seat = unknown> {
  private readonly capacity: number
  private readonly members = new Map<MemberId, Member<Seat>>()

  constructor(opts: MembersOptions) {
    this.capacity = opts.capacity
  }

  get size(): number {
    return this.members.size
  }

  get(id: MemberId): Member<Seat> | undefined {
    return this.members.get(id)
  }

  /** Everybody, in the order their lowest chair falls. */
  all(): Member<Seat>[] {
    return [...this.members.values()].sort((a, b) => (a.chairs[0] ?? -1) - (b.chairs[0] ?? -1))
  }

  /** Chairs nobody holds, ascending. */
  free(): number[] {
    const taken = new Set<number>()
    for (const m of this.members.values()) for (const c of m.chairs) taken.add(c)
    const out: number[] = []
    for (let i = 0; i < this.capacity; i++) if (!taken.has(i)) out.push(i)
    return out
  }

  /**
   * Seat somebody, on the lowest free chair. Returns their chairs, or [] when
   * the room is full — which the caller has to check, because a member with no
   * chair is not in the room.
   */
  join(id: MemberId, name: string): readonly number[] {
    const chair = this.free()[0]
    if (chair === undefined) return []
    this.members.set(id, { id, name, chairs: [chair], seats: [undefined] })
    return [chair]
  }

  /**
   * Put somebody on chairs they already hold, rather than finding them some.
   *
   * For rebuilding this from a store that already knows the answer. A room
   * whose memory can be lost while its connections outlive it has to keep the
   * membership on the connections themselves, so it has the seating already and
   * only wants the queries. `join` allocates, which is the wrong verb entirely
   * there: it hands out the lowest free chair and quietly reseats everybody in
   * whatever order they happen to be read in.
   */
  place(id: MemberId, name: string, chairs: readonly number[], seats: readonly (Seat | undefined)[] = []): void {
    const sorted = [...chairs].filter((c) => c >= 0 && c < this.capacity).sort((a, b) => a - b)
    this.members.set(id, { id, name, chairs: sorted, seats: sorted.map((_, i) => seats[i]) })
  }

  leave(id: MemberId): void {
    this.members.delete(id)
  }

  /**
   * Ask for `want` chairs in total.
   *
   * Giving chairs back is always allowed; taking them is limited by what is
   * going spare, so asking for six in a room where two are gone quietly gets
   * you four rather than failing. A room that refused would be a room where
   * somebody's couch silently seats fewer people than are sitting on it.
   */
  resize(id: MemberId, want: number): readonly number[] {
    const m = this.members.get(id)
    if (m === undefined) return []
    const keep = Math.max(1, Math.min(want, this.capacity))
    if (keep <= m.chairs.length) {
      const chairs = m.chairs.slice(0, keep)
      const next = { ...m, chairs, seats: m.seats.slice(0, keep) }
      this.members.set(id, next)
      return chairs
    }
    const spare = this.free()
    const chairs = [...m.chairs, ...spare.slice(0, keep - m.chairs.length)].sort((a, b) => a - b)
    this.members.set(id, { ...m, chairs, seats: chairs.map((_, i) => m.seats[i]) })
    return chairs
  }

  /** Set the game's blob for one of a member's chairs. */
  setSeat(id: MemberId, index: number, seat: Seat): void {
    const m = this.members.get(id)
    if (m === undefined || index < 0 || index >= m.chairs.length) return
    const seats = [...m.seats]
    seats[index] = seat
    this.members.set(id, { ...m, seats })
  }

  /**
   * Who holds the start button: the lowest chair in the room.
   *
   * Lowest rather than "whoever opened it", so a room whose opener has left
   * still has somebody able to start it — and the handover happens on its own,
   * with nothing to elect and nothing to announce.
   *
   * `except` leaves somebody out, for the moment a connection is closing but
   * the runtime still lists it.
   */
  host(except?: MemberId): MemberId | null {
    let best: Member<Seat> | null = null
    for (const m of this.members.values()) {
      if (m.id === except) continue
      const first = m.chairs[0]
      if (first === undefined) continue
      if (best === null || first < (best.chairs[0] ?? Infinity)) best = m
    }
    return best?.id ?? null
  }

  hostChair(except?: MemberId): number {
    const id = this.host(except)
    return id === null ? -1 : (this.members.get(id)?.chairs[0] ?? -1)
  }

  isHost(id: MemberId, except?: MemberId): boolean {
    return this.host(except) === id
  }

  /**
   * The room as everybody in it sees it: a name per chair, and the game's blob
   * per chair, with gaps as null.
   *
   * `name` is asked for per chair rather than taken from the member, because
   * the extra people on one machine are numbered off the first — nobody setting
   * up four controllers is going to type four names.
   */
  roster(
    name: (m: Member<Seat>, index: number) => string,
    except?: MemberId,
  ): { names: (string | null)[]; seats: (Seat | null)[] } {
    const names = new Array<string | null>(this.capacity).fill(null)
    const seats = new Array<Seat | null>(this.capacity).fill(null)
    for (const m of this.members.values()) {
      if (m.id === except) continue
      for (let i = 0; i < m.chairs.length; i++) {
        const c = m.chairs[i]!
        if (c < 0 || c >= this.capacity) continue
        names[c] = name(m, i)
        seats[c] = m.seats[i] ?? null
      }
    }
    return { names, seats }
  }

  clear(): void {
    this.members.clear()
  }
}
