// When a decision takes effect.
//
// Both cases below are bugs that shipped, in two different games, and both were
// silent: nothing threw, nothing logged, and several hundred unit tests passed
// either side of them. They are the reason this function exists on its own
// rather than being four lines inside a room.

import { describe, it, expect } from 'vitest'
import { rollbackClock, streamClock, DecisionLog, type ClockView } from '../src/index.ts'

const WINDOW = 14
const SLACK = 4

function view(head: number, last: Record<number, number>, auto: number[] = []): ClockView {
  return {
    head,
    lastFrom: (p) => last[p] ?? -1,
    isAutomatic: (p) => auto.includes(p),
  }
}

describe('a decision about somebody still sending', () => {
  const clock = rollbackClock({ window: WINDOW, slack: SLACK })

  it('is dated off their own last word, not the room’s', () => {
    // Player 1 stopped at 40; everybody else ran on to 54, which is the window
    // and is not lateness — it is the design.
    const at = clock.schedule(view(54, { 0: 54, 1: 40 }), 1)
    expect(at).toBe(40 + WINDOW + SLACK)
  })

  it('lands somewhere their peers can still reach', () => {
    // The peers stall at WINDOW past player 1's last word. A decision beyond
    // that is one nobody ever arrives at, so the wait never ends and the game
    // is frozen for good. Dated off the room's head it was always beyond it.
    const last = 40
    const horizon = last + WINDOW
    const at = clock.schedule(view(horizon, { 0: horizon, 1: last }), 1)
    const naive = horizon + WINDOW + SLACK // what measuring off the head gives
    expect(naive).toBeGreaterThan(horizon)
    expect(at).toBeGreaterThan(horizon)
    // Reachable: within one window of where the peers are held.
    expect(at - horizon).toBeLessThanOrEqual(WINDOW + SLACK)
  })
})

describe('a decision about a place already driven automatically', () => {
  const clock = rollbackClock({ window: WINDOW, slack: SLACK })

  it('is dated off the room, because nobody is waiting on it', () => {
    // Measured from the empty seat's own last word — which is -1, because it
    // has never spoken — a newcomer was dealt a place from point 17 while the
    // game was at 233. Their client rewound to reach it, ran off the end of
    // its history, and gave up: the room certain they were playing, the player
    // still watching, nothing anywhere saying so.
    const head = 233
    const at = clock.schedule(view(head, { 0: head }, [2]), 2)
    expect(at).toBe(head + WINDOW + SLACK)
    expect(at).toBeGreaterThan(head)
  })

  it('never dates a newcomer into the past', () => {
    // The shape of the bug, stated as the property rather than the number.
    const head = 233
    for (const p of [1, 2, 3, 4, 5]) {
      expect(clock.schedule(view(head, { 0: head }, [1, 2, 3, 4, 5]), p)).toBeGreaterThan(head)
    }
  })
})

describe('a clock for a game nobody predicts in', () => {
  it('has no horizon to stay inside', () => {
    const clock = streamClock()
    expect(clock.schedule(view(99, {}))).toBe(100)
  })
})

describe('the decision log', () => {
  it('keeps what was decided, in the order it was decided', () => {
    // Recorded as well as sent. A decision that was only broadcast is invisible
    // until somebody joins and replays the game — and a replay that does not
    // know who was driving produces a different game from everybody else's.
    const log = new DecisionLog<string>()
    log.add(10, 'a')
    log.add(4, 'b') // dated earlier, decided later: order is decision order
    log.add(20, 'c')
    expect(log.all().map((e) => e.body)).toEqual(['a', 'b', 'c'])
    expect(log.all().map((e) => e.seq)).toEqual([0, 1, 2])
    expect(log.all().map((e) => e.at)).toEqual([10, 4, 20])
  })
})
