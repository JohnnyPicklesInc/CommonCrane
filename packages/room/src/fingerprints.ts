// Noticing that two clients have stopped playing the same game.
//
// Everybody publishes a fingerprint of their world at agreed points and the
// room compares them. It never computes one — it could not, it does not
// simulate — so this is only a memory with a rule about when to speak up.
//
// The points have to be ones nobody is guessing about any more, which is the
// `Watermark`'s job and not this one's. A fingerprint of a predicted moment is
// a fingerprint of a guess, and two honest clients guess differently: compared
// there, every checkpoint disagrees the instant anybody moves.

import type { At } from './log.ts'

export interface FingerprintsOptions {
  /**
   * How many points to remember.
   *
   * Only enough to catch a disagreement, not to keep a history: the first one
   * is the only one that means anything, because everything after it is
   * downstream of the same divergence.
   */
  readonly keep: number
}

export class Fingerprints {
  private readonly keep: number
  private readonly seen = new Map<At, number>()
  private readonly told = new Set<At>()

  constructor(opts: FingerprintsOptions) {
    this.keep = opts.keep
  }

  /**
   * Take somebody's fingerprint, and say whether it disagrees with the one
   * already held for that point.
   *
   * True means tell the room. Only ever true once per point: a room that
   * announced every disagreement would announce one per client per checkpoint
   * for the rest of the game, all of them the same news.
   */
  offer(at: At, hash: number): boolean {
    if (!Number.isInteger(at) || this.told.has(at)) return false
    const first = this.seen.get(at)
    if (first === undefined) {
      this.seen.set(at, hash)
      // Oldest out, because a Map keeps insertion order and the oldest point is
      // the one nobody can still be catching up to.
      if (this.seen.size > this.keep) {
        const oldest = this.seen.keys().next()
        if (!oldest.done) this.seen.delete(oldest.value)
      }
      return false
    }
    if (first === hash) return false
    this.told.add(at)
    return true
  }

  /** Whether a disagreement has been announced at this point. */
  reported(at: At): boolean {
    return this.told.has(at)
  }

  /** Forget everything. A fresh game in the same room. */
  clear(): void {
    this.seen.clear()
    this.told.clear()
  }
}
