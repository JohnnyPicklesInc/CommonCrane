// What to show somebody looking for a room.

import { describe, it, expect } from 'vitest'
import { sift, type Listed } from '../src/index.ts'

const NOW = 1_000_000
const STALE = 150_000
const opts = { build: 'v1', now: NOW, staleMs: STALE }

function room(over: Partial<Listed> = {}): Listed {
  return {
    code: 'AAAA', host: 'Ann', players: 1, max: 6,
    since: NOW - 1000, build: 'v1', updated: NOW - 1000, ...over,
  }
}

describe('what is offered', () => {
  it('is the rooms on your own build', () => {
    const { offers } = sift(
      [['a', room({ code: 'AAAA' })], ['b', room({ code: 'BBBB', build: 'v2' })]],
      opts,
    )
    expect(offers.map((o) => o.code)).toEqual(['AAAA'])
  })

  it('is newest first', () => {
    const { offers } = sift(
      [
        ['a', room({ code: 'OLD', since: NOW - 9000 })],
        ['b', room({ code: 'NEW', since: NOW - 10 })],
      ],
      opts,
    )
    expect(offers.map((o) => o.code)).toEqual(['NEW', 'OLD'])
  })

  it('says whether a match is under way, and calls the old ones lobbies', () => {
    const { offers } = sift(
      [['a', room({ live: true })], ['b', room({ code: 'BBBB', live: undefined })]],
      opts,
    )
    expect(offers.map((o) => o.live)).toEqual([true, false])
  })
})

describe('what is thrown away', () => {
  it('is anything that has not confirmed itself lately', () => {
    const { offers, expired } = sift([['g:AAAA', room({ updated: NOW - STALE - 1 })]], opts)
    expect(offers).toEqual([])
    expect(expired).toEqual(['g:AAAA'])
  })

  it('includes dead rooms on other builds, not just your own', () => {
    // Filtered by build first, a dead entry on another build is skipped before
    // anything notices it is dead — and sits there for ever.
    const { expired } = sift(
      [['g:X', room({ build: 'v9', updated: NOW - STALE - 1 })]],
      opts,
    )
    expect(expired).toEqual(['g:X'])
  })

  it('includes an entry with no confirmation time at all', () => {
    // Comparing `undefined` against a cutoff is false, which is the wrong way
    // round: an entry that cannot show when it was last confirmed is exactly
    // the one to drop, and treating it as fresh leaves it listed for ever.
    const bad = { ...room(), updated: undefined } as unknown as Listed
    const { offers, expired } = sift([['g:X', bad]], opts)
    expect(offers).toEqual([])
    expect(expired).toEqual(['g:X'])
  })

  it('keeps a room that has confirmed itself just inside the window', () => {
    const { offers } = sift([['a', room({ updated: NOW - STALE + 1 })]], opts)
    expect(offers).toHaveLength(1)
  })
})
