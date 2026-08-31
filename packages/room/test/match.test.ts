// The transitions.
//
// Every test here is a bug that shipped, and every one of them was an ordering
// mistake between calls that were individually correct. That is why they live
// behind single methods now: the tests below could not fail without the API
// offering a wrong order to choose.

import { describe, it, expect } from 'vitest'
import { Match, rollbackClock } from '../src/index.ts'

const WINDOW = 14
const SILENCE = 4000

function match(): Match {
  return new Match({
    players: 8,
    clock: rollbackClock({ window: WINDOW, slack: 4 }),
    silenceMs: SILENCE,
  })
}

describe('beginning a match', () => {
  it('does not call everybody quiet on the opening tick', () => {
    // The bug, and it is worth stating as a property rather than a sequence.
    // Started by hand, the presence clock was reset over the players who held a
    // place — before anybody had been dealt one. Every clock stayed at zero, so
    // the first look called all of them quiet and handed every place to the
    // computer immediately. Two ends then applied those at different points and
    // played different matches.
    // The clock has to be well past the silence, or the test passes with the
    // bug still in: at a wall clock of one second nobody is four seconds quiet
    // whether their clock was started or not.
    const START = SILENCE * 10
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: START })
    expect(m.observe([0, 1], START)).toEqual([])
    expect(m.isAutomatic(0)).toBe(false)
    expect(m.isAutomatic(1)).toBe(false)
  })

  it('leaves the spare places to the computer from the start', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: SILENCE * 10 })
    expect(m.isAutomatic(2)).toBe(true)
    expect(m.isAutomatic(3)).toBe(true)
    // And they are what a latecomer is given.
    expect(m.vacant([0, 1])).toBe(2)
  })

  it('never dates a latecomer’s place into the past', () => {
    // A spare place has never spoken, so its last word is -1: dated off that,
    // the first arrival was dealt a place from a point hundreds of ticks behind
    // the match. Their client rewinds for it, runs off the end of its history,
    // and abandons it in silence — the room certain they are playing while they
    // are still watching.
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: SILENCE * 10 })
    for (let t = 0; t < 233; t++) m.contribute(0, t, [1], SILENCE * 10)
    const h = m.seat(2, SILENCE * 10)
    expect(h.at).toBeGreaterThan(m.head)
  })
})

describe('a player who goes quiet', () => {
  it('is called quiet once, and only after the silence is up', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    expect(m.observe([0, 1], SILENCE - 1)).toEqual([])
    const first = m.observe([0, 1], SILENCE + 1)
    expect(first.map((h) => h.p)).toEqual([0, 1])
    expect(first.every((h) => h.on)).toBe(true)
    // Still silent, but no longer news: a room that re-decided every look would
    // append a handover a second for the rest of the match.
    expect(m.observe([0, 1], SILENCE + 2)).toEqual([])
  })

  it('gets their place back the moment they speak', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    m.observe([0, 1], SILENCE + 1)
    expect(m.isAutomatic(1)).toBe(true)
    const back = m.contribute(1, 0, [7], SILENCE + 2)
    expect(back?.map((h) => h.on)).toEqual([false])
    expect(m.isAutomatic(1)).toBe(false)
  })

  it('is never called quiet while they are merely a long way behind', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    let now = 0
    for (let t = 0; t < 40; t++) {
      now += 1000
      m.contribute(1, t, [1], now)
      expect(m.observe([0, 1], now).some((h) => h.p === 1 && h.on)).toBe(false)
    }
  })
})

describe('a connection that goes', () => {
  it('changes hands at once rather than after the silence', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    const gone = m.leave(1, 100)
    expect(gone.map((h) => h.on)).toEqual([true])
    expect(m.isAutomatic(1)).toBe(true)
    // And is not announced twice when the clock comes round.
    expect(m.observe([0, 1], SILENCE + 1).some((h) => h.p === 1)).toBe(false)
  })
})

describe('what a latecomer is handed', () => {
  it('is a row per place, with no holes, and every handover since', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    m.contribute(0, 0, [1, 2, 3], 0)
    m.contribute(1, 0, [9], 0)
    const seated = m.seat(2, 0)
    const c = m.catchup()
    expect(c.log).toHaveLength(4)
    expect(c.log.every((r) => r.length === c.at + 1)).toBe(true)
    // Filled forward: a point somebody never spoke for is one they repeated
    // themselves on, which is what a client does with a gap anyway.
    expect(c.log[1]).toEqual([9, 9, 9])
    // And the handover that seated them is in the record, not merely sent.
    expect(c.handovers).toContainEqual(seated)
  })
})

describe('recycling a room', () => {
  it('forgets the match completely', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    m.contribute(0, 0, [1, 2, 3], 0)
    m.end()
    expect(m.started).toBe(false)
    expect(m.head).toBe(-1)
    expect(m.vacant([])).toBe(-1)
    expect(m.isAutomatic(2)).toBe(false)
    expect(m.catchup().handovers).toEqual([])
  })
})

describe('a change that is really two changes', () => {
  it('lands both halves on one point', () => {
    // Switching sides is giving one place up and taking another. Dated
    // separately they came apart — measured at eighty ticks here, and at a
    // hundred and twenty in the game this was taken from — and in between,
    // every client is playing a different match.
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    for (let t = 0; t < 200; t++) m.contribute(0, t, [1], 0)
    for (let t = 0; t < 120; t++) m.contribute(1, t, [1], 0)

    const swap = m.reassign([{ p: 1, on: true }, { p: 2, on: false }], 0)
    expect(swap.changes.map((c) => c.at)).toEqual([swap.at, swap.at])
  })

  it('picks a point nobody has already gone past', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    for (let t = 0; t < 200; t++) m.contribute(0, t, [1], 0)
    // Player 2 has never spoken, so its own last word is -1: taken alone that
    // dates it into the deep past, which is the failure this guards.
    const swap = m.reassign([{ p: 1, on: true }, { p: 2, on: false }], 0)
    expect(swap.at).toBeGreaterThan(m.head)
  })

  it('records every half, so a replay makes the same change', () => {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    m.contribute(0, 0, [1], 0)
    const swap = m.reassign([{ p: 1, on: true }, { p: 2, on: false }], 0)
    const recorded = m.catchup().handovers
    for (const c of swap.changes) expect(recorded).toContainEqual(c)
  })
})

describe('a room that has forgotten a match it is still running', () => {
  // Any host can lose an object's memory while its connections outlive it — a
  // restart, a redeploy, a failover, or a host that sheds idle objects and
  // rebuilds them on the next message. What comes back knows the match is on
  // and knows nothing about when.

  it('does not judge anybody silent for time it was not there for', () => {
    // A fresh clock has heard from nobody. Treated as though it had been
    // listening all along, everybody reads as quiet the moment it wakes and
    // every place is handed away at once — on the strength of a silence that
    // never happened.
    const woken = match()
    woken.resume({ roster: 4, playing: [0, 1], now: SILENCE * 100 })
    woken.contribute(0, 500, [1], SILENCE * 100)
    expect(woken.observe([0, 1], SILENCE * 100).map((h) => h.p)).toEqual([])
    expect(woken.isAutomatic(1)).toBe(false)
  })

  it('dates nothing until the match says where it is', () => {
    // With no history the schedule anchors on "never spoke", which is the very
    // beginning — so a handover in a match thousands of points along is dated
    // to the start, and every client rewinds for it, runs off the end of what
    // it keeps, and abandons it without a word.
    const woken = match()
    woken.resume({ roster: 4, playing: [0, 1], now: 0 })
    expect(woken.oriented).toBe(false)
    expect(woken.observe([0, 1], SILENCE * 100)).toEqual([])
    expect(woken.leave(1, SILENCE * 100)).toEqual([])
    expect(woken.vacant([0, 1])).toBe(-1)
  })

  it('picks up again as soon as it hears where the match is', () => {
    const woken = match()
    woken.resume({ roster: 4, playing: [0, 1], now: 0 })
    // Player nought speaks, which is both what orients the room and what keeps
    // them from being called quiet themselves.
    woken.contribute(0, 5000, [1], SILENCE)
    expect(woken.oriented).toBe(true)
    const gone = woken.observe([0, 1], SILENCE + 1)
    expect(gone.map((h) => h.p)).toEqual([1])
    // And dated ahead of where the match actually is, not at its beginning.
    expect(gone[0]!.at).toBeGreaterThan(5000)
  })
})

describe('compacting a long match', () => {
  // The only thing that keeps a match from growing without bound. Everything
  // before the point a world is remembered at is re-derivable from that world,
  // and costs nothing but memory to keep hold of.

  function played(to: number): Match {
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    for (let t = 0; t <= to; t++) {
      m.contribute(0, t, [t + 1], 0)
      m.contribute(1, t, [t + 100], 0)
    }
    return m
  }

  describe('deciding when to cut, rather than being told', () => {
    // `compact` is the mechanism and `offer` is the policy. The three rules
    // below are the ones every game with a growing log wrote for itself.

    function keeping(keep: number | undefined, to: number): Match {
      const m = new Match({
        players: 8,
        clock: rollbackClock({ window: WINDOW, slack: 4 }),
        silenceMs: SILENCE,
        keep,
      })
      m.begin({ roster: 4, playing: [0, 1], now: 0 })
      for (let t = 0; t <= to; t++) {
        m.contribute(0, t, [t + 1], 0)
        m.contribute(1, t, [t + 100], 0)
      }
      return m
    }

    it('holds a world without cutting to it while the log is short', () => {
      const m = keeping(100, 80)
      expect(m.offer(40, { world: 40 })).toBe(true)
      expect(m.from).toBe(0)
      expect(m.origin).toBeNull()
    })

    it('cuts to the newest one it holds once the log is long enough', () => {
      const m = keeping(100, 400)
      m.offer(40, { world: 40 })
      m.offer(200, { world: 200 })
      expect(m.from).toBe(200)
      expect(m.origin?.at).toBe(200)
    })

    it('never cuts at all when no limit is set', () => {
      const m = keeping(undefined, 4000)
      expect(m.offer(2000, { world: 2000 })).toBe(true)
      expect(m.from).toBe(0)
    })

    it('keeps the newest offer, not the first', () => {
      const m = keeping(100, 400)
      expect(m.offer(200, { world: 200 })).toBe(true)
      // Older than what it holds. Taking it would move the log's start
      // backwards, to inputs that have already been thrown away.
      expect(m.offer(150, { world: 150 })).toBe(false)
      expect(m.origin?.at).toBe(200)
    })

    it('refuses a world from the future', () => {
      // Past the head is past what anybody has said. Cutting there discards
      // contributions that are the only record of what happened.
      const m = keeping(100, 400)
      expect(m.offer(900, { world: 900 })).toBe(false)
      expect(m.from).toBe(0)
    })

    it('forgets the world when the room plays again', () => {
      // A rematch is a different game in the same room. A world held over from
      // the last one describes a rink nobody is standing on.
      const m = keeping(100, 400)
      m.offer(200, { world: 200 })
      expect(m.origin?.at).toBe(200)
      m.begin({ roster: 4, playing: [0, 1], now: 0 })
      expect(m.origin).toBeNull()
      for (let t = 0; t <= 400; t++) m.contribute(0, t, [t], 0)
      // And the offer it was holding is gone with it, rather than cutting the
      // new match back to the old one's rink the moment it gets long enough.
      expect(m.offer(200, { world: 'new' })).toBe(true)
      expect(m.origin?.state).toEqual({ world: 'new' })
    })
  })

  it('says where the log begins without building it', () => {
    const m = played(80)
    expect(m.from).toBe(0)
    m.compact(40, { world: true })
    expect(m.from).toBe(40)
    expect(m.from).toBe(m.catchup().from)
  })

  it('keeps only what is still to be replayed', () => {
    const m = played(200)
    expect(m.compact(150, 'the world at 150')).toBe(true)
    const c = m.catchup()
    expect(c.from).toBe(150)
    expect(c.at).toBe(200)
    expect(c.origin).toEqual({ at: 150, state: 'the world at 150' })
    // Fifty-one points of log rather than two hundred and one.
    expect(c.log[0]).toHaveLength(51)
    expect(c.log[0]![0]).toBe(151)
  })

  it('says where a replay starts, so nobody begins at the beginning', () => {
    // A latecomer handed rows starting at 150 and told nothing would replay
    // them from zero, which is a different match entirely.
    const m = played(200)
    expect(m.catchup().origin).toBeNull()
    m.compact(150, 'x')
    expect(m.catchup().origin?.at).toBe(150)
  })

  it('refuses to compact past the newest thing anybody has said', () => {
    // The log after that point is the only record there is of it.
    const m = played(200)
    expect(m.compact(201, 'x')).toBe(false)
    expect(m.catchup().from).toBe(0)
  })

  it('refuses to compact backwards', () => {
    const m = played(200)
    m.compact(150, 'x')
    expect(m.compact(100, 'y')).toBe(false)
    expect(m.catchup().origin?.state).toBe('x')
  })

  it('forgets where it started when the room plays again', () => {
    const m = played(200)
    m.compact(150, 'x')
    m.end()
    m.begin({ roster: 4, playing: [0, 1], now: 0 })
    expect(m.catchup().origin).toBeNull()
  })
})
