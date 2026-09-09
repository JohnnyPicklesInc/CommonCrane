// Taking a running match over from another machine.
//
// The one thing here that is genuinely new rather than rearranged, and the
// reason it can exist at all is that a room which never simulates *is* its log.
// So the payload written to describe a match to a latecomer is also everything
// needed to become the thing describing it, and what these tests check is that
// the round trip really is a round trip — because the failure mode is not an
// error, it is a room that carries on hosting a subtly different match.

import { describe, it, expect } from 'vitest'
import { Match, rollbackClock } from '../src/index.ts'
import { Room, type Member, type Decision } from '../src/room.ts'

const WINDOW = 14
const SILENCE = 4000
/** Well past the silence, or a test passes with the clock never started. */
const NOW = SILENCE * 10

function match(keep?: number): Match {
  return new Match({
    players: 8,
    clock: rollbackClock({ window: WINDOW, slack: 4 }),
    silenceMs: SILENCE,
    keep,
  })
}

/** A match played far enough forward to be worth taking over. */
function played(keep?: number): Match {
  const m = match(keep)
  m.begin({ roster: 4, playing: [0, 1], now: NOW })
  for (let t = 0; t < 200; t++) {
    m.contribute(0, t, [t + 1], NOW)
    m.contribute(1, t, [t + 2], NOW)
  }
  return m
}

describe('a match taken over from another machine', () => {
  it('comes back as the same match, log and all', () => {
    // The property the whole feature rests on. Not "it loads" — that a second
    // catchup taken from the new holder is indistinguishable from the first,
    // because that payload is what every later arrival replays.
    const before = played()
    const c = before.catchup()
    const after = match()
    expect(after.adopt({ roster: 4, playing: [0, 1], now: NOW, ...c })).toBe(true)
    expect(after.head).toBe(before.head)
    expect(after.from).toBe(before.from)
    expect(after.places).toBe(before.places)
    expect(after.catchup()).toEqual(c)
  })

  it('knows where the match is at once, so it can seat somebody', () => {
    // The whole difference from `resume`, which is the other way to pick a
    // running match up and has to guess. With no log the schedule anchors on
    // "never spoke" — a point at the opening of a match two hundred points
    // along — so `resume` refuses to date anything until somebody contributes,
    // and a latecomer arriving into that window is turned away. Holding the log
    // means head and lastFrom are real from the first moment.
    const c = played().catchup()

    const adopted = match()
    adopted.adopt({ roster: 4, playing: [0, 1], now: NOW, ...c })
    expect(adopted.oriented).toBe(true)
    expect(adopted.vacant([0, 1])).toBe(2)
    expect(adopted.seat(2, NOW).at).toBeGreaterThan(adopted.head)

    const resumed = match()
    resumed.resume({ roster: 4, playing: [0, 1], now: NOW })
    expect(resumed.oriented).toBe(false)
    expect(resumed.vacant([0, 1])).toBe(-1)
  })

  it('does not judge anybody silent for time it was not there for', () => {
    // The one thing it must NOT inherit. A fresh presence clock has heard from
    // nobody, so keeping the old room's idea of who was quiet — or starting from
    // zero — finds everybody silent a moment later and hands every place to the
    // computer at once. Both ends then apply those at different points.
    const c = played().catchup()
    const m = match()
    m.adopt({ roster: 4, playing: [0, 1], now: NOW, ...c })
    expect(m.observe([0, 1], NOW)).toEqual([])
    expect(m.isAutomatic(0)).toBe(false)
    expect(m.isAutomatic(1)).toBe(false)
  })

  it('reads who was driving what off the schedule', () => {
    // Better than `resume` can do: the handover schedule is a record rather than
    // an inference, so a player the old room had already handed to the computer
    // stays handed over instead of being treated as a fresh arrival.
    const before = played()
    // Both places are held throughout — that is what `observe` is asked to look
    // at — but only 0 is still speaking, so only 1 is quiet.
    const later = NOW + SILENCE + 1
    before.contribute(0, 200, [201], later)
    before.observe([0, 1], later)
    expect(before.isAutomatic(1)).toBe(true)

    const after = match()
    after.adopt({ roster: 4, playing: [0, 1], now: NOW, ...before.catchup() })
    expect(after.isAutomatic(1)).toBe(true)
    expect(after.isAutomatic(0)).toBe(false)
  })

  it('treats anybody no longer connected as the computer’s, whatever the schedule said', () => {
    // The schedule describes the room that died. Somebody who left during the
    // migration is in it as a player, and seating the new room on that leaves it
    // waiting for input from a machine that has gone — which stalls everybody,
    // because waiting is a hard mutual dependency.
    const c = played().catchup()
    const m = match()
    m.adopt({ roster: 4, playing: [0], now: NOW, ...c })
    expect(m.isAutomatic(0)).toBe(false)
    expect(m.isAutomatic(1)).toBe(true)
  })

  it('brings a compacted log back where it actually began', () => {
    // A long match has thrown its early inputs away and kept a world instead.
    // Adopted as though it began at zero, the new host would hand every later
    // arrival a replay that starts at the beginning and is fed inputs from
    // point four thousand.
    const m = played(50)
    m.offer(150, { rink: 'here' })
    expect(m.from).toBe(150)

    const after = match(50)
    const c = m.catchup()
    expect(after.adopt({ roster: 4, playing: [0, 1], now: NOW, ...c })).toBe(true)
    expect(after.from).toBe(150)
    expect(after.origin).toEqual({ at: 150, state: { rink: 'here' } })
    expect(after.catchup()).toEqual(c)
  })
})

describe('a payload that does not describe a match', () => {
  // Strict on purpose, and this is the one moment there is anything to check
  // against. A log a row short or a span off by one does not fail: it plays a
  // different game, in a room that believes it is hosting the right one.

  const base = () => played().catchup()

  it('is refused for a row short of the roster', () => {
    const c = base()
    const m = match()
    expect(m.adopt({ roster: 4, playing: [0, 1], now: NOW, ...c, log: c.log.slice(0, 3) })).toBe(
      false,
    )
    expect(m.started).toBe(false)
  })

  it('is refused for a span that does not match the points it claims', () => {
    const c = base()
    const m = match()
    expect(
      m.adopt({ roster: 4, playing: [0, 1], now: NOW, ...c, log: c.log.map((r) => r.slice(1)) }),
    ).toBe(false)
    expect(m.started).toBe(false)
  })

  it('is refused for a world dated anywhere but where the rows begin', () => {
    // The two have to be the same point. A state from earlier is a replay that
    // starts before the inputs it is given; one from later skips inputs that
    // have already been applied to it.
    const c = base()
    const m = match()
    expect(
      m.adopt({ roster: 4, playing: [0, 1], now: NOW, ...c, origin: { at: 7, state: {} } }),
    ).toBe(false)
    expect(m.started).toBe(false)
  })

  it('is refused for a roster the match could never lay out', () => {
    const c = base()
    expect(match().adopt({ roster: 99, playing: [0, 1], now: NOW, ...c })).toBe(false)
    expect(match().adopt({ roster: 0, playing: [0, 1], now: NOW, ...c })).toBe(false)
  })

  it('takes a match nobody has spoken for yet', () => {
    // Not a malformed payload but the edge next to one: a match that has begun
    // and that nobody has contributed to has `at` one behind `from`, and an
    // empty rectangle is the honest description of it.
    const m = match()
    m.begin({ roster: 4, playing: [0, 1], now: NOW })
    const c = m.catchup()
    expect(c.at).toBe(c.from - 1)
    const after = match()
    expect(after.adopt({ roster: 4, playing: [0, 1], now: NOW, ...c })).toBe(true)
    expect(after.head).toBe(c.at)
  })
})

// ---------------------------------------------------------------------------

type Settings = { mode: number }
type Seat = number

/** A room whose membership is a plain array the test moves about. */
function room() {
  const members: Member<string, Seat>[] = []
  const r = new Room<string, Settings, Seat>({
    capacity: 6,
    roster: 6,
    clock: rollbackClock({ window: WINDOW, slack: 4 }),
    silenceMs: SILENCE,
    recall: 64,
    heartbeatMs: 45_000,
    paceMs: 1000,
    settings: { mode: 0 },
    checkSettings: (raw) => {
      const m = (raw as Partial<Settings>)?.mode
      return m === 0 || m === 1 ? { mode: m } : null
    },
    checkSeat: (raw) => (raw === 0 || raw === 1 ? (raw as Seat) : null),
    members: () => members,
    plays: (seat) => seat === 0 || seat === 1,
  })
  const join = (who: string, seat: Seat) => {
    const at = r.arrive(who, { name: who, build: 'v1', announce: false, code: 'ABCD' }, NOW)
    for (const d of at) {
      if (d.kind === 'seated') {
        members.push({ who: d.who, chairs: [...d.chairs], name: who, seats: [seat], players: [] })
      }
    }
    return [...at, ...r.arrived(who, who, NOW)]
  }
  const deal = (out: Decision<string, Settings, Seat>[]) => {
    for (const d of out) {
      if (d.kind !== 'begun') continue
      for (const x of d.seating.dealt) {
        const i = members.findIndex((m) => m.who === (x.who as string))
        if (i >= 0) members[i] = { ...members[i]!, players: [...x.players] }
      }
    }
    return out
  }
  return { r, members, join, deal }
}

const find = <K extends Decision<string, Settings, Seat>['kind']>(
  out: Decision<string, Settings, Seat>[],
  kind: K,
) =>
  out.find((d) => d.kind === kind) as
    | Extract<Decision<string, Settings, Seat>, { kind: K }>
    | undefined

/** A room mid-match, and everything a survivor would be holding. */
function hosted() {
  const a = room()
  a.join('Alice', 0)
  a.join('Bob', 1)
  const begun = a.deal(a.r.begin('Alice', 2, NOW))
  const state = find(begun, 'remember')!.state
  for (let t = 0; t < 120; t++) {
    a.r.input('Alice', 0, t, [t + 1], NOW)
    a.r.input('Bob', 1, t, [t + 2], NOW)
  }
  return { a, state, seating: a.r.seating!, caught: a.r.match.catchup() }
}

describe('a room migrating to a survivor', () => {
  it('goes on handing latecomers the match the old room would have', () => {
    // What migration is for. The new host is a machine that was only ever a
    // client, and the proof it has really become the room is that somebody
    // walking in afterwards is told the same thing they would have been told
    // before — that payload is the match, so a difference here is two people
    // playing different games.
    const { a, state, seating, caught } = hosted()

    const b = room()
    // Bob's machine, which was the other client and is now the host. Both
    // players are still connected; only the old host's room is gone.
    b.members.push({ who: 'Bob', chairs: [1], name: 'Bob', seats: [1], players: [1] })
    b.members.push({ who: 'Alice', chairs: [0], name: 'Alice', seats: [0], players: [0] })

    const out = b.r.adopt(state, { seating, ...caught }, NOW)
    expect(out.map((d) => d.kind)).toEqual(['remember', 'lobby', 'listed', 'wake'])
    expect(b.r.started).toBe(true)
    expect(b.r.match.head).toBe(a.r.match.head)

    const before = find(a.join('Carol', 0), 'catchup')
    const after = find(b.join('Carol', 0), 'catchup')
    expect(after?.log).toEqual(before?.log)
    expect(after?.at).toBe(before?.at)
    expect(after?.origin).toEqual(before?.origin)
    expect(after?.seating).toEqual(before?.seating)
  })

  it('keeps what the match was laid out for, whatever the saved lobby says', () => {
    // The places are the one thing about a running match that cannot be worked
    // out again, and the state written down may well be from before the drop.
    // Restored in the wrong order the room comes up laid out for nothing and
    // has no place to give anybody.
    const { state, seating, caught } = hosted()
    const b = room()
    b.members.push({ who: 'Bob', chairs: [1], name: 'Bob', seats: [1], players: [1] })
    b.r.adopt({ ...state, places: 0 }, { seating, ...caught }, NOW)
    expect(b.r.match.places).toBe(seating.places)
    expect(b.r.seating).toEqual(seating)
  })

  it('leaves the room exactly as it was when the payload is no good', () => {
    // Half a migration is worse than none: a room that believes it is hosting
    // a match it cannot describe turns every arrival away and never says why.
    const { state, seating, caught } = hosted()
    const b = room()
    b.members.push({ who: 'Bob', chairs: [1], name: 'Bob', seats: [1], players: [1] })
    expect(b.r.adopt(state, { seating, ...caught, log: caught.log.slice(0, 1) }, NOW)).toEqual([])
    expect(b.r.started).toBe(false)
    expect(b.r.seating).toBeNull()
  })

  it('will not take one over while it is already running one', () => {
    const { a, state, seating, caught } = hosted()
    expect(a.r.adopt(state, { seating, ...caught }, NOW)).toEqual([])
  })
})
