// Questions about who is in the room, asked of the game's own record.

import { describe, it, expect } from 'vitest'
import { freeChairs, hostChair, roster, resizeChairs } from '../src/index.ts'

const named = (s: { name: string }, i: number): string =>
  i === 0 ? s.name : `${s.name} ${i + 1}`

describe('free chairs', () => {
  it('are the ones nobody holds, in order', () => {
    expect(freeChairs([{ chairs: [0], name: 'a' }, { chairs: [2, 3], name: 'b' }], 6))
      .toEqual([1, 4, 5])
  })
  it('are all of them in an empty room', () => {
    expect(freeChairs([], 3)).toEqual([0, 1, 2])
  })
})

describe('the start button', () => {
  it('sits on the lowest chair, not on whoever opened the room', () => {
    const room = [{ chairs: [3], name: 'c' }, { chairs: [1, 2], name: 'b' }]
    expect(hostChair(room)).toBe(1)
  })
  it('moves on its own when that person goes', () => {
    // Asked as though somebody had already left: the moment a connection is
    // closing but the host still lists it.
    const room = [{ chairs: [1, 2], name: 'b' }, { chairs: [3], name: 'c' }]
    expect(hostChair(room.filter((s) => s.name !== 'b'))).toBe(3)
  })
  it('is -1 in an empty room', () => {
    expect(hostChair([])).toBe(-1)
  })
})

describe('the roster', () => {
  it('is by chair with gaps, numbering extras off the first name', () => {
    const room = [{ chairs: [0, 1], name: 'Ann' }, { chairs: [3], name: 'Bo' }]
    expect(roster(room, 5, named).names).toEqual(['Ann', 'Ann 2', null, 'Bo', null])
  })
  it('carries the game blob per chair, untouched', () => {
    const room = [{ chairs: [1, 2], name: 'Ann', seats: [7, 9] }]
    expect(roster(room, 4, named).seats).toEqual([null, 7, 9, null])
  })
})

describe('asking for more chairs', () => {
  it('gives back what you no longer want', () => {
    expect(resizeChairs([0, 1, 2], 1, [])).toEqual([0])
  })
  it('gives what is spare rather than refusing', () => {
    // Asking for six in a room where two are gone should quietly get you four.
    expect(resizeChairs([0], 6, [3, 4, 5])).toEqual([0, 3, 4, 5])
  })
  it('never leaves somebody with no chair at all', () => {
    expect(resizeChairs([0], 0, [])).toEqual([0])
  })
})
