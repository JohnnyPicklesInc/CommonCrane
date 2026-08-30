// The line behind which nothing can change any more.
//
// A game that predicts and rewinds is, at the present moment, partly made up:
// every client is guessing what the others pressed and will be corrected when
// the truth arrives. Two honest clients therefore disagree about right now, and
// comparing fingerprints there reports a disagreement on essentially every
// checkpoint as soon as anybody moves.
//
// So they compare a moment slightly behind: the newest point for which every
// player's real input is in hand, where nobody is guessing about anybody and no
// arriving packet can change the answer. That is this.
//
// Two rules make it correct, and both were learned by getting them wrong.

import type { At } from './log.ts'

export interface WatermarkOptions {
  readonly players: number
  /**
   * Places nobody was in at the drop.
   *
   * Taken here rather than left to the caller on purpose. A place is released
   * from two moments — when somebody hands it over mid-game, and when the game
   * opens with nobody in it — and a caller that has to remember both will one
   * day remember one. That is the bug this argument exists to remove.
   */
  readonly absent?: readonly number[]
}

export class Watermark {
  private readonly players: number
  /** The point each player's input stopped being read, or -1 while it is. */
  private readonly releasedAt: At[]
  /** How far an unbroken run of each player's real input has been walked. */
  private readonly through: At[]

  constructor(opts: WatermarkOptions) {
    this.players = opts.players
    this.releasedAt = new Array<At>(opts.players).fill(-1)
    this.through = new Array<At>(opts.players).fill(-1)
    for (const p of opts.absent ?? []) {
      if (p >= 0 && p < opts.players) this.releasedAt[p] = 0
    }
  }

  /**
   * This player's input stops being read from `at`.
   *
   * Dated rather than a flag, because the difference matters: their input still
   * counts for everything before `at` and counts for nothing after it. Treated
   * as a plain "ignore them", the line could run past a point their input was
   * still missing from, and a fingerprint taken there is one a late packet can
   * still change — a disagreement reported between two clients who were both
   * right.
   */
  released(player: number, at: At): void {
    if (player < 0 || player >= this.players) return
    this.releasedAt[player] = at
  }

  /** And starts being read again from `at`. */
  reclaimed(player: number, at: At): void {
    if (player < 0 || player >= this.players) return
    this.releasedAt[player] = -1
    // Nothing before this point was theirs to speak for, so the walk must not
    // wait for input they were never going to send.
    if (this.through[player]! < at - 1) this.through[player] = at - 1
  }

  /**
   * The newest point every player's real input is known for.
   *
   * `holds(player, at)` answers "do I have their real input for that point" —
   * the caller's own store, whatever shape it is in.
   *
   * Walked forward one point at a time, and never jumped to the newest thing
   * seen. A lost run leaves a hole, and the newest point seen is past it: trust
   * that and the points inside the hole are treated as settled when they were
   * in fact simulated from a guess that no arriving packet ever corrected. Both
   * ends then publish fingerprints for states that could never agree and report
   * a desync no amount of waiting resolves. A phone changing masts loses runs
   * often enough to hit this again and again.
   */
  line(holds: (player: number, at: At) => boolean): At {
    let low = Infinity
    for (let p = 0; p < this.players; p++) {
      let c = this.through[p]!
      while (holds(p, c + 1)) c++
      this.through[p] = c
      // A place whose input is no longer read holds nothing down past the point
      // it was released. Left in, one player going quiet pins this line where
      // they stopped — and every fingerprint with it, so the desync check stops
      // happening at all for the rest of the game, silently.
      const r = this.releasedAt[p]!
      if (r >= 0 && c >= r - 1) continue
      if (c < low) low = c
    }
    return low === Infinity ? -1 : low
  }

  /** Forget everything. A fresh game in the same room. */
  clear(): void {
    this.releasedAt.fill(-1)
    this.through.fill(-1)
  }
}
