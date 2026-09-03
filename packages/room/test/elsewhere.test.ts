// Talking to a relay that is not on this origin.
//
// A build somebody else hosts — itch, CrazyGames, Poki — runs inside their
// page. `location.host` is theirs, so every URL this library builds by
// prefixing it asks a games site for a game room, and the failure is silent
// on the developer's own machine where the two happen to be the same.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { WsTransport, inviteUrl } from '../src/client.ts'

/** The last URL a WebSocket was opened with. */
function socketSpy(): { url: () => string } {
  let seen = ''
  class FakeSocket {
    onopen: (() => void) | null = null
    onmessage: ((e: unknown) => void) | null = null
    onclose: (() => void) | null = null
    readyState = 1
    constructor(url: string) {
      seen = url
    }
    send(): void {}
    close(): void {}
  }
  vi.stubGlobal('WebSocket', FakeSocket)
  return { url: () => seen }
}

function at(href: string): void {
  const u = new URL(href)
  vi.stubGlobal('location', {
    protocol: u.protocol,
    host: u.host,
    origin: u.origin,
    pathname: u.pathname,
    search: u.search,
    hash: u.hash,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a relay somewhere else', () => {
  it('asks this origin when the base is a path — unchanged', () => {
    const spy = socketSpy()
    at('https://puckpenguin.example/')
    new WsTransport({ code: 'AB12', name: 'Chris', build: 'x' })
    expect(spy.url()).toContain('wss://puckpenguin.example/api/rooms/AB12/ws')
  })

  it('asks the relay when the base is absolute', () => {
    const spy = socketSpy()
    // The portal's page, which is exactly the case that used to break.
    at('https://poki.example/en/g/bird-hockey')
    new WsTransport({
      code: 'AB12',
      name: 'Chris',
      build: 'x',
      base: 'https://relay.example.com/api/rooms',
    })
    expect(spy.url()).toContain('wss://relay.example.com/api/rooms/AB12/ws')
    expect(spy.url()).not.toContain('poki.example')
  })

  it('carries the scheme across, so a secure page cannot open an open socket', () => {
    const spy = socketSpy()
    at('https://poki.example/')
    new WsTransport({ code: 'AB12', name: 'C', build: 'x', base: 'http://dev.local/api/rooms' })
    expect(spy.url().startsWith('ws://dev.local')).toBe(true)

    const spy2 = socketSpy()
    new WsTransport({ code: 'AB12', name: 'C', build: 'x', base: 'https://live.example/api/rooms' })
    expect(spy2.url().startsWith('wss://live.example')).toBe(true)
  })

  it('invites to where we are, when that is a place worth linking to', () => {
    at('https://puckpenguin.example/play')
    expect(inviteUrl('AB12')).toBe('https://puckpenguin.example/play?room=AB12')
  })

  it('invites home instead when the page belongs to somebody else', () => {
    at('https://poki.example/en/g/bird-hockey')
    expect(inviteUrl('AB12', 'https://puckpenguin.example')).toBe(
      'https://puckpenguin.example/?room=AB12',
    )
    // A trailing slash on the home origin must not double up.
    expect(inviteUrl('AB12', 'https://puckpenguin.example/')).toBe(
      'https://puckpenguin.example/?room=AB12',
    )
  })
})
