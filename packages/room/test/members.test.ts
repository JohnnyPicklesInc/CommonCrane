// Who is in the room.
//
// The couch cases are the ones worth testing: one machine holding several
// chairs is what makes this awkward, and writing the single-chair case
// separately would be two sets of rules to keep in step.

import { describe, it, expect } from 'vitest'
import { Members, makeCode, isCode } from '../src/index.ts'

const named = (m: { name: string }, i: number): string =>
  i === 0 ? m.name : `${m.name} ${i + 1}`

describe('turning up', () => {
  it('takes the lowest free chair', () => {
    const r = new Members({ capacity: 4 })
    expect(r.join('a', 'Ann')).toEqual([0])
    expect(r.join('b', 'Bo')).toEqual([1])
    r.leave('a')
    // And the chair that was freed is the next one handed out, rather than the
    // room drifting upwards until it is full of gaps.
    expect(r.join('c', 'Cai')).toEqual([0])
  })

  it('turns nobody away quietly — an empty list is a full room', () => {
    const r = new Members({ capacity: 2 })
    r.join('a', 'Ann')
    r.join('b', 'Bo')
    expect(r.join('c', 'Cai')).toEqual([])
    expect(r.get('c')).toBeUndefined()
  })
})

describe('a couch', () => {
  it('takes as many chairs as it asks for', () => {
    const r = new Members({ capacity: 6 })
    r.join('a', 'Ann')
    expect(r.resize('a', 3)).toEqual([0, 1, 2])
    expect(r.free()).toEqual([3, 4, 5])
  })

  it('gets what is going spare rather than being refused', () => {
    // Asking for six in a room where two are gone should quietly get you four.
    // A room that refused would be one where somebody's couch seats fewer
    // people than are sitting on it, with nothing said.
    const r = new Members({ capacity: 6 })
    r.join('a', 'Ann')
    r.join('b', 'Bo')
    r.resize('b', 2) // Bo's couch takes chairs 1 and 2
    // Ann asks for six and gets the four that are left, rather than nothing.
    expect(r.resize('a', 6)).toEqual([0, 3, 4, 5])
  })

  it('gives chairs back, and they become free again', () => {
    const r = new Members({ capacity: 6 })
    r.join('a', 'Ann')
    r.resize('a', 4)
    expect(r.resize('a', 1)).toEqual([0])
    expect(r.free()).toEqual([1, 2, 3, 4, 5])
  })

  it('never leaves somebody with no chair at all', () => {
    const r = new Members({ capacity: 6 })
    r.join('a', 'Ann')
    expect(r.resize('a', 0)).toEqual([0])
  })
})

describe('the start button', () => {
  it('is held by the lowest chair, not by whoever opened the room', () => {
    const r = new Members({ capacity: 4 })
    r.join('a', 'Ann')
    r.join('b', 'Bo')
    expect(r.isHost('a')).toBe(true)
    // The opener leaves. Somebody still has to be able to start it, and
    // "lowest" hands that over on its own with nothing to elect.
    r.leave('a')
    expect(r.isHost('b')).toBe(true)
  })

  it('can be asked as though somebody had already gone', () => {
    // The moment a connection is closing but the runtime still lists it.
    const r = new Members({ capacity: 4 })
    r.join('a', 'Ann')
    r.join('b', 'Bo')
    expect(r.host('a')).toBe('b')
    expect(r.hostChair('a')).toBe(1)
  })
})

describe('the roster', () => {
  it('is by chair, with gaps, and numbers the extras off the first name', () => {
    const r = new Members({ capacity: 4 })
    r.join('a', 'Ann')
    r.resize('a', 2)
    r.join('b', 'Bo')
    const { names } = r.roster(named)
    expect(names).toEqual(['Ann', 'Ann 2', 'Bo', null])
  })

  it('carries the game own blob per chair, untouched', () => {
    const r = new Members<{ side: number }>({ capacity: 3 })
    r.join('a', 'Ann')
    r.resize('a', 2)
    r.setSeat('a', 1, { side: 7 })
    const { seats } = r.roster(named)
    expect(seats).toEqual([null, { side: 7 }, null])
  })
})

describe('a room code', () => {
  it('avoids the characters that get misread', () => {
    for (let i = 0; i < 200; i++) {
      const c = makeCode()
      expect(c).toHaveLength(4)
      expect(/[O0I1]/.test(c)).toBe(false)
      expect(isCode(c)).toBe(true)
    }
  })

  it('rejects anything it would not have minted', () => {
    expect(isCode('ABC')).toBe(false)
    expect(isCode('AB0D')).toBe(false)
    expect(isCode('abcd')).toBe(false)
  })
})

describe('rebuilding the room from somewhere else', () => {
  it('places people on the chairs they already hold', () => {
    // A room that keeps its membership on the connections themselves — because
    // it hibernates — already knows the seating and only wants the queries.
    // Allocating instead of placing hands out the lowest free chair and
    // reseats everybody in whatever order they happen to be read in.
    const r = new Members<number>({ capacity: 6 })
    r.place('b', 'Bo', [2, 3], [1, 1])
    r.place('a', 'Ann', [0])
    const { names, seats } = r.roster(named)
    expect(names).toEqual(['Ann', null, 'Bo', 'Bo 2', null, null])
    expect(seats).toEqual([null, null, 1, 1, null, null])
    expect(r.hostChair()).toBe(0)
  })
})
