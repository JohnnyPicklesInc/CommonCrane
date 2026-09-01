// The joins, which is the only reason `Room` exists.
//
// Each part underneath is tested on its own elsewhere. What is checked here is
// the order they run in and what falls out of it — which is where every bug
// that actually happened in these games lived.

import { describe, it, expect } from 'vitest'
import { Room, type Member, type Decision } from '../src/room.ts'
import { rollbackClock } from '../src/schedule.ts'

type Settings = { mode: number }
type Seat = number

const WINDOW = 14
const SILENCE = 4000
const CAPACITY = 6
const ROSTER = 6

/** A room whose membership is a plain array the test moves about. */
function room() {
  const members: Member<string, Seat>[] = []
  const r = new Room<string, Settings, Seat>({
    capacity: CAPACITY,
    roster: ROSTER,
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
  /** Do what a host would do with the decisions it was handed. */
  const apply = (name: string, out: Decision<string, Settings, Seat>[]) => {
    for (const d of out) {
      if (d.kind === 'seated') {
        const m = members.find((x) => x.who === d.who)
        if (m === undefined) {
          members.push({ who: d.who, chairs: [...d.chairs], name, seats: [], players: [] })
        } else {
          const i = members.indexOf(m)
          members[i] = { ...m, chairs: [...d.chairs] }
        }
      }
    }
    return out
  }
  const join = (who: string, opts: Partial<{ build: string; announce: boolean }> = {}) => {
    const at = r.arrive(
      who,
      { name: who, build: opts.build ?? 'v1', announce: opts.announce ?? false, code: 'ABCD' },
      0,
    )
    apply(who, at)
    const after = at.some((d) => d.kind === 'refuse') ? [] : r.arrived(who, who, 0)
    return [...at, ...after]
  }
  const sit = (who: string, seats: Seat[]) => {
    const i = members.findIndex((m) => m.who === who)
    members[i] = { ...members[i]!, seats }
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
  const drop = (who: string) => {
    const i = members.findIndex((m) => m.who === who)
    if (i >= 0) members.splice(i, 1)
  }
  return { r, members, join, sit, deal, drop }
}

const kinds = (out: Decision<string, Settings, Seat>[]) => out.map((d) => d.kind)
const find = <K extends Decision<string, Settings, Seat>['kind']>(
  out: Decision<string, Settings, Seat>[],
  kind: K,
) => out.find((d) => d.kind === kind) as Extract<Decision<string, Settings, Seat>, { kind: K }> | undefined

describe('who gets in, and on whose terms', () => {
  it('seats the first arrival and lets them set the terms', () => {
    const { r, join } = room()
    const out = join('Alice', { announce: true, build: 'v1' })
    expect(find(out, 'seated')?.chairs).toEqual([0])
    expect(r.build).toBe('v1')
    expect(r.code).toBe('ABCD')
  })

  it('does not let a later arrival set them, even in chair zero', () => {
    // The security rule, and the shape it broke in. The lowest chair is handed
    // out again the moment its occupant leaves, so a joiner taking it could put
    // a private room on the public board over its owner's head.
    const { join, drop } = room()
    join('Alice', { announce: false })
    join('Bob')
    drop('Alice')
    const out = join('Carol', { announce: true })
    expect(find(out, 'seated')?.chairs).toEqual([0])
    expect(find(out, 'listed')?.entry).toBeNull()
  })

  it('turns away a different build', () => {
    const { join } = room()
    join('Alice', { build: 'v1' })
    const out = join('Bob', { build: 'v2' })
    expect(kinds(out)).toEqual(['refuse'])
  })
})

describe('taking more chairs', () => {
  it('describes the room only once the move has been made', () => {
    // The trap this split exists for. A lobby handed back alongside a seating
    // describes the room a moment before the seating — everybody is told about
    // a change that has not happened, and the next thing they are told is the
    // same room again.
    const { r, join, members } = room()
    join('Alice')
    join('Bob')
    const out = r.chairs('Bob', 3)
    expect(kinds(out)).toEqual(['seated'])
    expect(find(out, 'seated')?.chairs).toEqual([1, 2, 3])
    // Only now, once the caller has moved them.
    const i = members.findIndex((m) => m.who === 'Bob')
    members[i] = { ...members[i]!, chairs: [1, 2, 3] }
    const view = find(r.refresh(), 'lobby')!.view
    expect(view.players.filter(Boolean).length).toBe(4)
    expect(view.players.slice(1, 4)).toEqual(['Bob', 'Bob 2', 'Bob 3'])
  })

  it('hands over what is going spare rather than refusing', () => {
    const { r, join } = room()
    join('Alice')
    join('Bob')
    expect(find(r.chairs('Bob', 6), 'seated')?.chairs).toEqual([1, 2, 3, 4, 5])
  })
})

describe('proposing what everybody plays', () => {
  it('offers the room to the list again, in case the card was built from it', () => {
    // A card can be built out of the settings — which arena, which two sides —
    // and the room cannot know whether this game's is. Saying nothing leaves
    // the board advertising a room that has changed underneath it.
    const { r, join } = room()
    join('Alice', { announce: true })
    join('Bob')
    const out = r.propose('Alice', { mode: 1 })
    expect(kinds(out)).toContain('listed')
    expect(find(out, 'listed')?.entry).not.toBeNull()
  })

  it('says nothing at all when it is refused', () => {
    const { r, join } = room()
    join('Alice', { announce: true })
    expect(r.propose('Alice', { mode: 9 })).toEqual([])
  })
})

describe('the drop', () => {
  it('numbers places from zero however the chairs fell', () => {
    // A lobby that lost its middle chair still starts a match numbered from
    // zero with no holes, which is the only numbering a simulation understands.
    const { r, join, sit, deal, drop } = room()
    join('Alice')
    join('Bob')
    join('Carol')
    sit('Alice', [0]); sit('Bob', [1]); sit('Carol', [0])
    drop('Bob')
    const out = deal(r.begin('Alice', 3, 0))
    const begun = find(out, 'begun')!
    expect(begun.seating.chairs).toEqual([0, 2])
    expect(begun.seating.names).toEqual(['Alice', 'Carol'])
    expect(begun.seating.seats).toEqual([0, 0])
  })

  it('leaves out somebody who asked for no preference', () => {
    // Not the same as not having answered. "Anywhere" is a thing people ask
    // for, and the blob is opaque, so the room has to be told what it means.
    const { r, join, sit, deal } = room()
    join('Alice')
    join('Bob')
    sit('Alice', [0])
    sit('Bob', [-1 as Seat])
    const out = deal(r.begin('Alice', 2, 0))
    expect(find(out, 'begun')!.seating.names).toEqual(['Alice'])
    // And they are still in the room, and still shown in it.
    expect(find(out, 'begun')!.seating.dealt.find((d) => d.who === 'Bob')?.players).toEqual([])
  })

  it('leaves out anybody who has not said where they want to sit', () => {
    const { r, join, sit, deal } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0])
    const out = deal(r.begin('Alice', 2, 0))
    expect(find(out, 'begun')!.seating.names).toEqual(['Alice'])
    // And they are a watcher, which the game already knows how to be.
    expect(find(out, 'begun')!.seating.dealt.find((d) => d.who === 'Bob')?.players).toEqual([])
  })

  it('belongs to the host alone', () => {
    const { r, join, sit } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    expect(r.begin('Bob', 2, 0)).toEqual([])
    expect(r.started).toBe(false)
  })

  it('counts everybody as present, so nobody is retired on the first point', () => {
    const { r, join, sit, deal } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    deal(r.begin('Alice', 2, 0))
    // A moment later, well inside the silence.
    expect(r.tick(100).filter((d) => d.kind === 'handovers')).toEqual([])
  })
})

describe('the clock', () => {
  it('retires somebody who has gone quiet, without an input to prompt it', () => {
    // The whole point of having one. Everything else is measured against
    // whoever is furthest along, which fails when that player stops too.
    const { r, join, sit, deal } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    deal(r.begin('Alice', 2, 0))
    const out = r.tick(SILENCE + 1000)
    const changes = find(out, 'handovers')?.changes ?? []
    expect(changes.map((c) => c.p).sort()).toEqual([0, 1])
    expect(changes.every((c) => c.on)).toBe(true)
  })

  it('starts itself, rather than waiting for a beat that never comes', () => {
    // A heartbeat only ever rescheduled by itself never starts. Everything
    // works and forty-five seconds later the room falls off the list and
    // nobody is noticed going quiet again — with nothing anywhere to say so.
    const { join } = room()
    expect(find(join('Alice'), 'wake')?.inMs).toBe(45_000)
  })

  it('stops when the last person goes', () => {
    const { r, join, drop } = room()
    join('Alice')
    drop('Alice')
    const out = r.depart('Alice', { name: 'Alice', players: [] }, 0)
    expect(find(out, 'wake')?.inMs).toBeNull()
    // And in that order: stop the clock before the room is thrown away.
    expect(kinds(out).indexOf('wake')).toBeLessThan(kinds(out).indexOf('recycle'))
  })

  it('does not offer the same listing again on every beat', () => {
    // The clock runs often enough to notice somebody going quiet, and a
    // listing is a call to another object. Said on every beat, a room being
    // played makes one a second for ever whether or not anything changed — and
    // a host that gates incoming events behind an outstanding call spends that
    // gap not relaying anybody's input. A match where two people are each
    // waiting on the other stops dead.
    const { r, join } = room()
    join('Alice', { announce: true })
    join('Bob')
    expect(kinds(r.tick(0))).toContain('listed')
    expect(kinds(r.tick(1000))).not.toContain('listed')
    expect(kinds(r.tick(2000))).not.toContain('listed')
  })

  it('offers it again when something about it changed', () => {
    const { r, join } = room()
    join('Alice', { announce: true })
    r.tick(0)
    join('Bob')
    expect(kinds(r.tick(1000))).toContain('listed')
  })

  it('and again when it has gone long enough to go stale', () => {
    // An entry outlives its last confirmation by a while and no longer; a room
    // that stopped confirming would quietly fall off the board.
    const { r, join } = room()
    join('Alice', { announce: true })
    r.tick(0)
    expect(kinds(r.tick(1000))).not.toContain('listed')
    expect(kinds(r.tick(45_000))).toContain('listed')
  })

  it('asks to be looked at often while a match is running, rarely otherwise', () => {
    // A beat pitched to keep a public listing alive is far too slow to notice
    // anybody going quiet — and slower than a host keeps an idle object, so by
    // the time it fires the room has forgotten the match it was meant to judge.
    const { r, join, sit, deal } = room()
    join('Alice')
    join('Bob')
    expect(find(r.tick(0), 'wake')?.inMs).toBe(45_000)
    sit('Alice', [0])
    sit('Bob', [1])
    deal(r.begin('Alice', 2, 0))
    expect(find(r.tick(0), 'wake')?.inMs).toBe(1000)
  })

  it('says when it wants looking at again', () => {
    const { r, join } = room()
    join('Alice')
    expect(find(r.tick(0), 'wake')?.inMs).toBe(45_000)
  })
})

describe('leaving', () => {
  it('hands a departing player their places straight away', () => {
    const { r, join, sit, deal, drop } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    deal(r.begin('Alice', 2, 0))
    r.input('Alice', 0, 0, [1], 0)
    r.input('Bob', 1, 0, [1], 0)
    drop('Bob')
    // Removed first, which is what some hosts do — the handovers still happen.
    const out = r.depart('Bob', { name: 'Bob', players: [1] }, 100)
    expect(find(out, 'handovers')?.changes.map((c) => c.p)).toEqual([1])
  })

  it('takes the listing down before throwing the room away', () => {
    // Order, not presence. Wiping the storage loses the code the entry is filed
    // under, so delisting afterwards strands it until it goes stale.
    const { r, join, drop } = room()
    join('Alice', { announce: true })
    drop('Alice')
    const out = r.depart('Alice', { name: 'Alice', players: [] }, 0)
    expect(kinds(out)).toEqual(['left', 'listed', 'wake', 'recycle'])
    expect(find(out, 'listed')?.entry).toBeNull()
  })

  it('stops advertising a chair the leaver still nominally holds', () => {
    const { join, r } = room()
    join('Alice', { announce: true })
    join('Bob')
    // Not yet removed from the roster, which is what a closing socket looks like.
    const out = r.depart('Bob', { name: 'Bob', players: [] }, 0)
    expect(find(out, 'listed')?.entry?.players).toBe(1)
  })
})

describe('a room that lost its memory', () => {
  it('picks the match back up from the connections, not from nothing', () => {
    // Left to itself it calls everybody quiet a moment later and dates their
    // handovers to the opening of a match that is thousands of points along.
    const { r, join, sit, deal, members } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    deal(r.begin('Alice', 2, 0))
    r.input('Alice', 0, 0, [1, 2, 3], 0)

    // A fresh object with the same people still connected.
    const woken = room()
    woken.members.push(...members)
    woken.r.restore({ build: 'v1', code: 'ABCD', announced: false, since: 0 }, true)
    expect(woken.r.tick(100).filter((d) => d.kind === 'handovers')).toEqual([])
    // And it will not seat a latecomer in a match it cannot describe.
    const out = woken.r.arrive('Zoe', { name: 'Zoe', build: 'v1', announce: false, code: 'ABCD' }, 100)
    expect(kinds(out)).toEqual(['refuse'])
  })

  it('picks it back up laid out for the places it was dropped with', () => {
    // A room lays out for two places, is evicted, and comes back believing it
    // has as many places as it could ever have. The first person to speak
    // orients it — and the next latecomer is handed place two of a two-place
    // match, which is a place no client has anything for.
    //
    // The layout is the one thing about a running match that the connections
    // are no evidence of: the spare places are precisely the ones nobody is
    // sitting in. So it is written down at the drop.
    const { r, join, sit, deal, members } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    const begun = deal(r.begin('Alice', 2, 0))
    const state = find(begun, 'remember')?.state
    expect(state?.places).toBe(2)

    const woken = room()
    woken.members.push(...members)
    woken.r.restore(state!, true)
    // Somebody speaks, which is what tells a resumed room where the match is.
    woken.r.input('Alice', 0, 0, [1, 2, 3], 100)
    woken.members.push({ who: 'Zoe', chairs: [2], name: 'Zoe', seats: [], players: [] })
    expect(woken.r.take('Zoe', () => true)).toBeNull()
  })

  it('falls back to the roster for a room written down before the layout was', () => {
    // An older stored state has no layout in it. Nothing better is available,
    // so it behaves as it did before — and is no worse off.
    const { r, join, sit, deal, members } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    deal(r.begin('Alice', 2, 0))

    const woken = room()
    woken.members.push(...members)
    woken.r.restore({ build: 'v1', code: 'ABCD', announced: false, since: 0 }, true)
    woken.r.input('Alice', 0, 0, [1, 2, 3], 100)
    woken.members.push({ who: 'Zoe', chairs: [2], name: 'Zoe', seats: [], players: [] })
    expect(woken.r.take('Zoe', () => true)).toBe(2)
  })

  it('lays a rematch out for the places the drop settled on', () => {
    // The seating everybody rebuilds from says one number; the match used to
    // be started on another, so the room went on offering places the game had
    // never been told about.
    const { r, join, sit, deal } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    deal(r.begin('Alice', 2, 0))
    r.input('Alice', 0, 0, [1], 0)
    const again = r.rematch(10)
    expect(find(again, 'begun')?.seating.places).toBe(2)
    expect(r.match.places).toBe(2)
  })
})

describe('somebody who speaks without contributing', () => {
  it('is not called quiet, though they never send an input', () => {
    // The machine that simulates, on the netcode where only one does. It is
    // the busiest thing in the room and sends no input at all — its own never
    // leaves it. Judged on the input path alone the room takes its place away
    // and gives it to the computer, with somebody sitting there driving it.
    const { r, join, sit, deal } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    deal(r.begin('Alice', 2, 0))
    // Bob contributes, so the match knows where it is. Alice never does.
    r.input('Bob', 1, 0, [1], 0)

    // Alice keeps saying she is there, by some other means.
    let out = r.tick(SILENCE - 1)
    r.heard('Alice', SILENCE - 1)
    r.input('Bob', 1, 1, [1], SILENCE - 1)
    r.heard('Alice', SILENCE * 2)
    r.input('Bob', 1, 2, [1], SILENCE * 2)
    out = r.tick(SILENCE * 2 + 1)
    const handed = out.flatMap((d) => (d.kind === 'handovers' ? d.changes : []))
    expect(handed.filter((h) => h.p === 0 && h.on)).toEqual([])
  })

  it('and is, the moment they stop', () => {
    // The control: the same room, saying nothing at all.
    const { r, join, sit, deal } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    deal(r.begin('Alice', 2, 0))
    r.input('Bob', 1, 0, [1], 0)
    const out = r.tick(SILENCE * 2)
    const handed = out.flatMap((d) => (d.kind === 'handovers' ? d.changes : []))
    expect(handed.some((h) => h.p === 0 && h.on)).toBe(true)
  })

  it('says nothing about where the match has got to', () => {
    // A frame proves somebody is alive. It does not say which point the match
    // is on — so a room that has lost its memory is no closer to knowing, and
    // must still date nothing. Dating a decision from a guess about that is
    // the failure `oriented` exists to prevent.
    const { r, join, sit, deal, members } = room()
    join('Alice'); join('Bob')
    sit('Alice', [0]); sit('Bob', [1])
    const begun = deal(r.begin('Alice', 2, 0))
    const state = find(begun, 'remember')?.state

    const woken = room()
    woken.members.push(...members)
    woken.r.restore(state!, true)
    expect(woken.r.match.oriented).toBe(false)
    woken.r.heard('Alice', 10)
    expect(woken.r.match.oriented).toBe(false)
    // And a contribution, which does say where it is, still does.
    woken.r.input('Alice', 0, 40, [1], 20)
    expect(woken.r.match.oriented).toBe(true)
  })
})

describe('the listing', () => {
  it('is stamped from the moment it was given, not the wall clock', () => {
    // The one line in the room that read a clock of its own. It is the field
    // `sift` compares for staleness, so the least testable line in the file
    // was the one feeding the staleness rule.
    const { r, join } = room()
    join('Alice', { announce: true })
    expect(find(r.refresh(4242), 'listed')?.entry?.updated).toBe(4242)
    expect(find(r.tick(9999), 'listed')?.entry?.updated).toBe(9999)
  })
})

describe('disagreement', () => {
  it('says so once, and only once', () => {
    const { r } = room()
    expect(r.fingerprint(60, 111)).toEqual([])
    expect(kinds(r.fingerprint(60, 222))).toEqual(['disagreed'])
    expect(r.fingerprint(60, 333)).toEqual([])
  })

describe('a watcher taking a place', () => {
  it('is seated in one place and dated once, without reseating the room', () => {
    // Two shapes of game. Where control stays with whoever was given it, this
    // is the whole answer; where it wanders, the whole assignment has to be
    // re-derived and `settle` is that. A game of the first kind broadcasting a
    // whole lineup would be telling everybody about six places to change one.
    const { r, join, sit, deal, members } = room()
    join('Alice')
    join('Bob')
    sit('Alice', [0])
    sit('Bob', [1])
    deal(r.begin('Alice', 4, 0))
    join('Zoe')
    const place = r.take('Zoe', () => true)
    expect(place).toBe(2)
    const i = members.findIndex((m) => m.who === 'Zoe')
    members[i] = { ...members[i]!, players: [place!] }
    const dated = r.sit(place!, 0)
    expect(dated.p).toBe(2)
    expect(dated.on).toBe(false)
    // Ahead of the log, not behind it: a point already gone past is one every
    // client would have to rewind to, and some of them cannot reach.
    expect(dated.at).toBeGreaterThanOrEqual(r.match.head)
  })
})
})
