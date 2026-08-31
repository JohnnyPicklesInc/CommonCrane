// Noticing a deploy, which nothing has ever tested.
//
// The failure is the quietest kind there is: it does not throw, it does not
// look wrong, and the only symptom is that people are turned away at a door
// they do not know they are on the wrong side of.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { watchForUpdates } from '../src/client.ts'

/** An origin serving a given stamp, or refusing to answer. */
function origin(body: unknown | 'unreachable' | 'broken') {
  const calls: string[] = []
  const fake = vi.fn(async (url: string) => {
    calls.push(url)
    if (body === 'unreachable') throw new Error('offline')
    if (body === 'broken') return { ok: false, json: async () => ({}) }
    return { ok: true, json: async () => body }
  })
  vi.stubGlobal('fetch', fake)
  return { calls }
}

/** Let the immediate first poll settle. */
const settle = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('watching for a newer build', () => {
  it('says so when the origin is serving something else', async () => {
    origin({ build: '222' })
    const told = vi.fn()
    const stop = watchForUpdates({ build: '111' }, told)
    await settle()
    expect(told).toHaveBeenCalledTimes(1)
    stop()
  })

  it('says nothing when it is serving the same thing', async () => {
    origin({ build: '111' })
    const told = vi.fn()
    const stop = watchForUpdates({ build: '111' }, told)
    await settle()
    expect(told).not.toHaveBeenCalled()
    stop()
  })

  it('says nothing when the origin cannot be reached', async () => {
    // Offline, or a deploy mid-flight. Announcing an update because a request
    // failed is how a plane journey turns into a reload prompt every minute.
    origin('unreachable')
    const told = vi.fn()
    const stop = watchForUpdates({ build: '111' }, told)
    await settle()
    expect(told).not.toHaveBeenCalled()
    stop()
  })

  it('says nothing when the stamp is not a stamp', async () => {
    origin({ nothing: true })
    const told = vi.fn()
    const stop = watchForUpdates({ build: '111' }, told)
    await settle()
    expect(told).not.toHaveBeenCalled()
    stop()
  })

  it('says nothing when the stamp is missing', async () => {
    origin('broken')
    const told = vi.fn()
    const stop = watchForUpdates({ build: '111' }, told)
    await settle()
    expect(told).not.toHaveBeenCalled()
    stop()
  })

  it('tells them once, however long they leave the tab open', async () => {
    // Somebody who has been told and carried on does not need telling every
    // minute, and a banner that reappears is worse than one that waits.
    vi.useFakeTimers()
    origin({ build: '222' })
    const told = vi.fn()
    const stop = watchForUpdates({ build: '111', everyMs: 1000 }, told)
    await vi.advanceTimersByTimeAsync(5000)
    expect(told).toHaveBeenCalledTimes(1)
    stop()
    vi.useRealTimers()
  })

  it('keeps asking until there is something to say', async () => {
    vi.useFakeTimers()
    const { calls } = origin({ build: '111' })
    const stop = watchForUpdates({ build: '111', everyMs: 1000 }, () => {})
    await vi.advanceTimersByTimeAsync(3500)
    expect(calls.length).toBeGreaterThan(2)
    stop()
    vi.useRealTimers()
  })

  it('stops when told to', async () => {
    vi.useFakeTimers()
    const { calls } = origin({ build: '111' })
    const stop = watchForUpdates({ build: '111', everyMs: 1000 }, () => {})
    await vi.advanceTimersByTimeAsync(1500)
    const asked = calls.length
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.length).toBe(asked)
    vi.useRealTimers()
  })

  it('asks the origin, past anything holding the old copy', async () => {
    const { calls } = origin({ build: '222' })
    const stop = watchForUpdates({ build: '111', stamp: '/where.json' }, () => {})
    await settle()
    expect(calls).toContain('/where.json')
    stop()
  })
})

describe('the service worker, which is what actually runs in a browser', () => {
  /** A navigator with a worker, and a handle on the events it would raise. */
  function browser(controlled: boolean) {
    const listeners: Record<string, (() => void)[]> = {}
    const reg = { update: vi.fn(async () => {}) }
    const sw = {
      controller: controlled ? {} : null,
      ready: Promise.resolve(reg),
      addEventListener: (kind: string, fn: () => void) => {
        ;(listeners[kind] ??= []).push(fn)
      },
    }
    vi.stubGlobal('navigator', { serviceWorker: sw })
    return { reg, fire: (kind: string) => (listeners[kind] ?? []).forEach((f) => f()) }
  }

  it('says so the moment a new worker takes the page over', async () => {
    // New code is already installed underneath us. That is worth saying at
    // once rather than waiting up to a minute for the next poll.
    origin({ build: '111' }) // the stamp agrees, so only the worker can speak
    const b = browser(true)
    const told = vi.fn()
    const stop = watchForUpdates({ build: '111' }, told)
    await settle()
    b.fire('controllerchange')
    expect(told).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stays quiet when a worker claims the page for the first time', async () => {
    // No controller before means a first-ever install, not a replacement.
    // Nothing stale is being swapped out, so there is no news — and telling
    // somebody to update on their very first visit is nonsense.
    origin({ build: '111' })
    const b = browser(false)
    const told = vi.fn()
    const stop = watchForUpdates({ build: '111' }, told)
    await settle()
    b.fire('controllerchange')
    expect(told).not.toHaveBeenCalled()
    stop()
  })

  it('asks the worker to look as well as asking the origin', async () => {
    // Two signals, because either can arrive first.
    origin({ build: '111' })
    const b = browser(true)
    const stop = watchForUpdates({ build: '111' }, () => {})
    await settle()
    expect(b.reg.update).toHaveBeenCalled()
    stop()
  })

  it('still notices from the stamp when the worker never says anything', async () => {
    origin({ build: '222' })
    browser(true)
    const told = vi.fn()
    const stop = watchForUpdates({ build: '111' }, told)
    await settle()
    expect(told).toHaveBeenCalledTimes(1)
    stop()
  })
})
