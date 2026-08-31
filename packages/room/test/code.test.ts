// Room codes somebody has to be able to read aloud.
//
// These tests existed once and were deleted by accident, along with the file
// they were sharing with something else. Worth saying, because nothing noticed:
// the suite stayed green and the count went down by four.

import { describe, it, expect } from 'vitest'
import { makeCode, isCode } from '../src/index.ts'

describe('a room code', () => {
  it('avoids the characters that get misread down a phone', () => {
    for (let i = 0; i < 500; i++) {
      const c = makeCode()
      expect(c).toHaveLength(4)
      expect(/[O0I1]/.test(c)).toBe(false)
    }
  })

  it('is drawn without bias', () => {
    // Thirty-two characters and 256 bytes, so the byte-to-character map divides
    // evenly. If it did not, some letters would come up half as often as
    // others — which nobody would notice and which shrinks the space of codes.
    const seen = new Map<string, number>()
    for (let i = 0; i < 20_000; i++) {
      for (const ch of makeCode()) seen.set(ch, (seen.get(ch) ?? 0) + 1)
    }
    expect(seen.size).toBe(32)
    const counts = [...seen.values()]
    const lowest = Math.min(...counts)
    const highest = Math.max(...counts)
    expect(highest / lowest).toBeLessThan(1.3)
  })

  it('can be asked for at another length', () => {
    expect(makeCode(6)).toHaveLength(6)
    expect(isCode(makeCode(6), 6)).toBe(true)
  })
})

describe('recognising one', () => {
  it('accepts what it mints', () => {
    for (let i = 0; i < 200; i++) expect(isCode(makeCode())).toBe(true)
  })

  it('rejects the wrong length, the wrong case and the banned characters', () => {
    expect(isCode('ABC')).toBe(false)
    expect(isCode('ABCDE')).toBe(false)
    expect(isCode('abcd')).toBe(false)
    expect(isCode('AB0D')).toBe(false)
    expect(isCode('ABID')).toBe(false)
    expect(isCode('')).toBe(false)
  })
})
