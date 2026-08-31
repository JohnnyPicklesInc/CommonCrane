// The room before the game starts, and the settings it carries into one.
//
// Every game in the family wrote this out and they all wrote the same thing:
// a roster, one blob the host sets for the whole room, and one blob each person
// sets for themselves. What made the five look different was only what they
// called those two — a track, a matchup, an arena, a side, a bike, a weapon.
//
// So both are opaque here and validated by the game. The room stores what comes
// back and never looks inside: five different shapes is not five different
// rules, it is one rule about somebody else's data.

import type { Seated } from './seating.ts'

/**
 * Check a proposal, or refuse it.
 *
 * Refused whole rather than repaired. A repaired setting is worse than a
 * refused one, because the person who asked watches their choice silently
 * become somebody else's — and a value the game would not have chosen is a
 * value its simulation was never tested against.
 */
export type Check<T> = (raw: unknown) => T | null

export interface LobbyOptions<Settings, Seat> {
  /** What the room plays when nobody has chosen. */
  readonly settings: Settings
  readonly checkSettings: Check<Settings>
  readonly checkSeat: Check<Seat>
}

/** What everybody in the room is looking at. */
export interface LobbyView<Settings, Seat> {
  /** A name per chair, gaps as null. */
  readonly players: (string | null)[]
  /** Each person's own choice, per chair. */
  readonly seats: (Seat | null)[]
  /** The one the host sets for everybody. */
  readonly settings: Settings
  /** Which chair holds the start button. */
  readonly host: number
  /** Whether the room is offered to the public list. */
  readonly announced: boolean
}

/** What a room has to remember across losing its memory. */
export interface LobbyState<Settings> {
  readonly settings: Settings
  readonly announced: boolean
  readonly build: string
  readonly code: string
  /** When the room opened, for ordering the public list. */
  readonly since: number
}

export class Lobby<Settings, Seat> {
  private readonly opts: LobbyOptions<Settings, Seat>
  private state: LobbyState<Settings>

  constructor(opts: LobbyOptions<Settings, Seat>) {
    this.opts = opts
    this.state = {
      settings: opts.settings,
      announced: false,
      build: '',
      code: '',
      since: 0,
    }
  }

  get settings(): Settings {
    return this.state.settings
  }

  get announced(): boolean {
    return this.state.announced
  }

  get build(): string {
    return this.state.build
  }

  get code(): string {
    return this.state.code
  }

  get since(): number {
    return this.state.since
  }

  /**
   * What to persist, and what to put back afterwards.
   *
   * A room can lose its memory while the people in it stay connected, so this
   * is the part that has to survive: what everybody agreed to play, and the
   * terms the room was opened on.
   */
  snapshot(): LobbyState<Settings> {
    return this.state
  }

  restore(s: Partial<LobbyState<Settings>>): void {
    this.state = { ...this.state, ...s }
  }

  /**
   * The terms of the room, set once by whoever opened it.
   *
   * Only from the arrival that opened it — never from whoever happens to be in
   * the lowest chair, because that chair is handed out again the moment its
   * occupant leaves. See `admit`, which decides which arrival that was.
   */
  open(opts: { build: string; code: string; announced: boolean; now: number }): void {
    this.state = {
      ...this.state,
      build: opts.build,
      code: opts.code,
      announced: opts.announced,
      since: opts.now,
    }
  }

  /**
   * The host proposes what everybody plays.
   *
   * Two gates, and both matter. Only the host, because there is one of it and
   * it is in front of everybody — a guest who wants a different arena asks out
   * loud. And only before the drop, because the settings are folded into the
   * state every client builds, so changing them mid-game is not a change of
   * mind, it is two people playing different games.
   */
  propose(isHost: boolean, started: boolean, raw: unknown): Settings | null {
    if (!isHost || started) return null
    const next = this.opts.checkSettings(raw)
    if (next === null) return null
    this.state = { ...this.state, settings: next }
    return next
  }

  /** Whether to offer the room publicly. The host's, like the settings. */
  announce(isHost: boolean, on: boolean): boolean {
    if (!isHost) return false
    this.state = { ...this.state, announced: on }
    return true
  }

  /** Somebody's own choice for one of their chairs. Theirs alone to make. */
  choose(raw: unknown): Seat | null {
    return this.opts.checkSeat(raw)
  }

  /**
   * The room as everybody in it sees it.
   *
   * One shape for every game, because the two blobs are the only things that
   * ever differed and neither is looked at here.
   */
  view(
    seated: Iterable<Seated<Seat>>,
    capacity: number,
    name: (s: Seated<Seat>, index: number) => string,
    host: number,
  ): LobbyView<Settings, Seat> {
    const players = new Array<string | null>(capacity).fill(null)
    const seats = new Array<Seat | null>(capacity).fill(null)
    for (const s of seated) {
      for (let i = 0; i < s.chairs.length; i++) {
        const c = s.chairs[i]!
        if (c < 0 || c >= capacity) continue
        players[c] = name(s, i)
        seats[c] = s.seats?.[i] ?? null
      }
    }
    return { players, seats, settings: this.state.settings, host, announced: this.state.announced }
  }
}
