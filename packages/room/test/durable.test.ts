// The glue, against fakes. It decides nothing, so what is checked is that it
// does not lose anything.

import { describe, it, expect } from 'vitest'
import { held, hold, sendTo, broadcast, beat, type Socket, type Held } from '../src/durable.ts'

interface Extra extends Held {
  seats: number[]
}
const blank: Extra = { chairs: [], name: '?', players: [], seats: [] }

function socket(): Socket & { sent: string[]; store: unknown } {
  const s = {
    sent: [] as string[],
    store: null as unknown,
    send(m: string) {
      s.sent.push(m)
    },
    serializeAttachment(v: unknown) {
      s.store = v
    },
    deserializeAttachment() {
      return s.store
    },
  }
  return s
}

describe('what a connection holds', () => {
  it('reads as empty rather than null on a socket nothing has been put on', () => {
    expect(held(socket(), blank)).toEqual(blank)
  })

  it('changes one field and leaves the rest standing', () => {
    // The whole reason this is a function. Six places in one game were
    // spreading the old attachment over a new one by hand, and one short spread
    // loses somebody's name with the type checker perfectly happy.
    const ws = socket()
    hold(ws, blank, { name: 'Alice', chairs: [0], seats: [1] })
    hold(ws, blank, { players: [2] })
    expect(held(ws, blank)).toEqual({ name: 'Alice', chairs: [0], seats: [1], players: [2] })
  })
})

describe('sending', () => {
  it('does not take the handler down when a socket has gone', () => {
    // A socket can die between being chosen and being written to. Throwing
    // loses the other nine people's copy of whatever it was.
    const dead = socket()
    dead.send = () => {
      throw new Error('gone')
    }
    const live = socket()
    const ctx = { getWebSockets: () => [dead, live] }
    expect(() => broadcast(ctx, { t: 'x' })).not.toThrow()
    expect(live.sent).toEqual(['{"t":"x"}'])
    expect(() => sendTo(dead, { t: 'x' })).not.toThrow()
  })

  it('spares one when asked', () => {
    const a = socket()
    const b = socket()
    broadcast({ getWebSockets: () => [a, b] }, { t: 'x' }, a)
    expect(a.sent).toEqual([])
    expect(b.sent.length).toBe(1)
  })
})

describe('the heartbeat', () => {
  function alarms() {
    let at: number | null = null
    return {
      get at() {
        return at
      },
      getAlarm: async () => at,
      setAlarm: async (t: number) => {
        at = t
      },
      deleteAlarm: async () => {
        at = null
      },
    }
  }

  it('sets one when there is none', async () => {
    const a = alarms()
    await beat(a, 45_000)
    expect(a.at).not.toBeNull()
  })

  it('leaves a pending one alone rather than pushing it further out', async () => {
    // Rescheduling on every call is how a room that is busy never gets looked
    // at: each message moves the beat out again and it never arrives.
    const a = alarms()
    await beat(a, 45_000)
    const first = a.at
    await beat(a, 45_000)
    expect(a.at).toBe(first)
  })

  it('stops when the room says it wants nothing', async () => {
    const a = alarms()
    await beat(a, 45_000)
    await beat(a, null)
    expect(a.at).toBeNull()
  })
})
