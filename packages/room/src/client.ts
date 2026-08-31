// Getting to a room and staying on it.
//
// Deliberately thin. Everything interesting happens either in the room or in
// the game's own simulation; this only carries messages between them, and the
// one thing it is careful about is that a bad frame is not worth tearing a
// match down over.
//
// Kept apart from the rest of the library because it is the only part that
// wants a browser. The room side must not drag `WebSocket` and `location` in
// behind it, so this lives at its own entry point.

/**
 * A way to talk to a room.
 *
 * An interface rather than a class so a game can play with no room at all —
 * offline is simply the absence of one, which is a great deal tidier than a
 * connection that pretends.
 */
export interface Transport<Out, In> {
  send(msg: Out): void
  close(): void
  /** Whether the room can still hear us. */
  readonly open: boolean
  onMessage: (msg: In) => void
  onClose: () => void
}

export interface WsOptions {
  /** The room to join. */
  readonly code: string
  /** What to call yourself. */
  readonly name: string
  /** This client's build. A room seats only clients that match it. */
  readonly build: string
  /**
   * Offer the room to the public list.
   *
   * Only meaningful from whoever opens it: a room reads this from its first
   * arrival alone, so a later joiner cannot put somebody else's private room
   * on the board.
   */
  readonly announce?: boolean
  readonly onOpen?: () => void
  /** Where the rooms live. Only worth setting if yours are somewhere else. */
  readonly base?: string
}

export class WsTransport<Out, In> implements Transport<Out, In> {
  private readonly ws: WebSocket
  onMessage: (msg: In) => void = () => {}
  onClose: () => void = () => {}

  constructor(opts: WsOptions) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const base = opts.base ?? '/api/rooms'
    const q = new URLSearchParams({ name: opts.name, v: opts.build })
    if (opts.announce === true) q.set('pub', '1')
    this.ws = new WebSocket(
      `${proto}://${location.host}${base}/${encodeURIComponent(opts.code)}/ws?${q}`,
    )
    this.ws.onopen = () => opts.onOpen?.()
    this.ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as In)
      } catch {
        // A malformed frame is not worth tearing the match down over.
      }
    }
    this.ws.onclose = () => this.onClose()
    this.ws.onerror = () => this.onClose()
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  send(msg: Out): void {
    if (this.open) this.ws.send(JSON.stringify(msg))
  }

  close(): void {
    this.ws.close()
  }
}

/** Mint a room code. The room is not created until somebody connects to it. */
export async function createRoom(base = '/api/rooms'): Promise<string> {
  const r = await fetch(base, { method: 'POST' })
  if (!r.ok) throw new Error(`could not create a room (${r.status})`)
  const j = (await r.json()) as { code: string }
  return j.code
}

/**
 * Public rooms waiting for people, on this exact build.
 *
 * Returns nothing rather than throwing when the list is unreachable. This is
 * polled on a timer behind a menu somebody is looking at, and a blip should
 * read as "no games right now" rather than stacking an error over the buttons
 * every few seconds.
 */
export async function listRooms<G>(build: string, base = '/api/games'): Promise<G[]> {
  try {
    const r = await fetch(`${base}?v=${encodeURIComponent(build)}`, { cache: 'no-store' })
    if (!r.ok) return []
    const j = (await r.json()) as { games?: unknown }
    return Array.isArray(j.games) ? (j.games as G[]) : []
  } catch {
    return []
  }
}

/** `?room=ABCD` and `#room=ABCD` invite links. */
export function roomFromUrl(): string | null {
  const q = new URLSearchParams(location.search).get('room')
  if (q !== null && q.length > 0) return q.toUpperCase()
  const h = location.hash.match(/room=([A-Za-z0-9]+)/)
  return h === null ? null : h[1]!.toUpperCase()
}

export function inviteUrl(code: string): string {
  return `${location.origin}${location.pathname}?room=${code}`
}
