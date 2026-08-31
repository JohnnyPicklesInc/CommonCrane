// Who gets in, and as what.

import { describe, it, expect } from 'vitest'
import { admit } from '../src/index.ts'

const open = { free: [0, 1, 2], started: false, vacant: -1, build: 'v1' }

describe('an ordinary arrival', () => {
  it('takes the lowest free chair', () => {
    expect(admit(open, { name: 'Ann', build: 'v1' })).toEqual({
      as: 'play', chair: 0, opener: false,
    })
  })

  it('is turned away from a full room, and told why', () => {
    const a = admit({ ...open, free: [] }, { name: 'Ann', build: 'v1' })
    expect(a.as).toBe('refuse')
    expect(a.as === 'refuse' && a.reason.length).toBeGreaterThan(0)
  })
})

describe('the first person in', () => {
  it('is marked as the one who sets the terms', () => {
    // The security rule. Whoever opens a room decides the build everybody must
    // match and whether it goes on the public list — and both have to be read
    // from that arrival alone. Taken from whoever happens to be asking,
    // somebody joining a private room can put it on the board over its owner's
    // head.
    const a = admit({ ...open, build: '' }, { name: 'Ann', build: 'v9' })
    expect(a).toEqual({ as: 'play', chair: 0, opener: true })
  })

  it('and nobody after them is', () => {
    expect(admit(open, { name: 'Bo', build: 'v1' })).toEqual({
      as: 'play', chair: 0, opener: false,
    })
  })
})

describe('a different build', () => {
  it('is refused, with both versions in the message', () => {
    const a = admit(open, { name: 'Bo', build: 'v2' })
    expect(a.as).toBe('refuse')
    expect(a.as === 'refuse' && a.reason).toContain('v2')
    expect(a.as === 'refuse' && a.reason).toContain('v1')
  })

  it('is let in when the client is too old to say what it is', () => {
    // Only a client predating the question reports nothing, and there is
    // nothing to compare it against.
    expect(admit(open, { name: 'Bo', build: '' }).as).toBe('play')
  })
})

describe('a match already running', () => {
  it('seats a newcomer to watch when a place is being kept warm', () => {
    // With a chair: a watcher is in the room and on the roster, and takes that
    // chair back with them when they ask to play.
    expect(admit({ ...open, started: true, vacant: 3 }, { name: 'Bo', build: 'v1' }))
      .toEqual({ as: 'watch', chair: 0 })
  })

  it('turns them away when there is no place for them', () => {
    expect(admit({ ...open, started: true, vacant: -1 }, { name: 'Bo', build: 'v1' }).as)
      .toBe('refuse')
  })

  it('still refuses a mismatched build before offering a seat', () => {
    // Reloading into a deploy that landed mid-match is exactly how somebody
    // arrives on new code, and seating them would desync the room rather than
    // the one client.
    expect(admit({ ...open, started: true, vacant: 3 }, { name: 'Bo', build: 'v2' }).as)
      .toBe('refuse')
  })
})
