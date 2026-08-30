// Who has gone quiet, judged on a wall clock.
//
// Two rules are worth more than the code that enforces them, because both were
// bought with bugs:
//
// Silence, never distance. Being a long way behind is what a prediction window
// is *for*, and somebody who is still sending is here however far back they
// are. Judged by distance, a player who had just been given something to drive
// was relieved of it a second later every time, because a newcomer sits at the
// far end of that window until their first inputs have made the round trip.
//
// A clock, not the leader's position. Every other measure in a room is taken
// against whoever is furthest along, and that works right up until *they* stop
// too: one silent player stalls every peer at the prediction cap, the leader
// stops advancing because it is stalled as well, and a position-based clock
// freezes at exactly the moment it was needed. Seconds keep passing regardless.

export interface PresenceOptions {
  /** How many players there may be. */
  readonly players: number
  /**
   * How long somebody may say nothing before they are called quiet.
   *
   * Seconds rather than a moment. One second catches a phone changing masts, a
   * lid closing, and a tab the browser has decided to slow down — and taking
   * somebody's entity away for that, then handing it back when they reappear,
   * is worse than the pause it saves.
   */
  readonly silenceMs: number
}

/** What changed at the last look. Empty when nothing did, which is most looks. */
export interface PresenceChange {
  /** Players who have just been judged quiet. */
  readonly quiet: readonly number[]
  /** Players who have just been heard from again. */
  readonly back: readonly number[]
}

const NOTHING: PresenceChange = { quiet: [], back: [] }

export class Presence {
  private readonly opts: PresenceOptions
  private readonly heard: number[]
  private readonly silent: boolean[]

  constructor(opts: PresenceOptions) {
    this.opts = opts
    this.heard = new Array<number>(opts.players).fill(0)
    this.silent = new Array<boolean>(opts.players).fill(false)
  }

  /** Somebody spoke. Anything at all counts; it does not have to be an input. */
  hear(player: number, now: number): void {
    if (player < 0 || player >= this.opts.players) return
    this.heard[player] = now
  }

  /** Start the clock for a player without pretending they have spoken yet. */
  reset(player: number, now: number): void {
    if (player < 0 || player >= this.opts.players) return
    this.heard[player] = now
    this.silent[player] = false
  }

  /** True if this player is currently judged quiet. */
  isQuiet(player: number): boolean {
    return this.silent[player] === true
  }

  /**
   * Look at the clock and report what changed.
   *
   * `held` is who is currently somebody's responsibility — an unclaimed place
   * cannot go quiet, and a spectator holds nothing to be taken away.
   *
   * Call this on arriving traffic *and* on a timer. Traffic alone is free and
   * self-firing, because whoever is stalled is by definition still
   * transmitting and their own messages drive the check that frees them; its
   * one blind spot is a room where everybody has gone quiet at once, and that
   * is exactly when nothing else will fire either.
   */
  look(held: Iterable<number>, now: number): PresenceChange {
    let quiet: number[] | null = null
    let back: number[] | null = null
    for (const p of held) {
      if (p < 0 || p >= this.opts.players) continue
      const isQuiet = now - (this.heard[p] ?? 0) > this.opts.silenceMs
      if (isQuiet === this.silent[p]) continue
      this.silent[p] = isQuiet
      if (isQuiet) (quiet ??= []).push(p)
      else (back ??= []).push(p)
    }
    if (quiet === null && back === null) return NOTHING
    return { quiet: quiet ?? [], back: back ?? [] }
  }

  /** Forget everybody. A room being recycled for a fresh game. */
  clear(): void {
    this.heard.fill(0)
    this.silent.fill(false)
  }
}
