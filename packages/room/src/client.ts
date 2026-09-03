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
  /**
   * Where the rooms live. Only worth setting if yours are somewhere else.
   *
   * A path (`/api/rooms`) means this origin, which is the ordinary case: one
   * Worker serves both the bundle and the rooms, so asking relatively is the
   * honest thing to do.
   *
   * An absolute URL (`https://relay.example.com/api/rooms`) means somewhere
   * else, which is what a build hosted by a portal needs — there
   * `location.host` belongs to them, and a relative path would ask a games
   * site for a game room.
   */
  readonly base?: string
}

/**
 * `ws(s)://host/path` for a base that may be either form.
 *
 * Absolute in, absolute out, with the scheme carried across — `https` becomes
 * `wss`, so a portal build cannot be talked into an insecure socket from a
 * secure page. Relative in, this origin out, exactly as before.
 */
function wsBase(base: string): string {
  if (/^https?:\/\//.test(base)) return base.replace(/^http/, 'ws')
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${base}`
}

export class WsTransport<Out, In> implements Transport<Out, In> {
  private readonly ws: WebSocket
  onMessage: (msg: In) => void = () => {}
  onClose: () => void = () => {}

  constructor(opts: WsOptions) {
    const base = opts.base ?? '/api/rooms'
    const q = new URLSearchParams({ name: opts.name, v: opts.build })
    if (opts.announce === true) q.set('pub', '1')
    this.ws = new WebSocket(`${wsBase(base)}/${encodeURIComponent(opts.code)}/ws?${q}`)
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

/**
 * A link that seats the person you send it to.
 *
 * `home` is for a build somebody else hosts. There the address bar belongs to
 * the portal and the game is in an iframe several levels down, so a copy of
 * this page's URL is a link to a page of games rather than to this room —
 * point it at a deploy of ours instead, which serves the same bundle and reads
 * `?room=` on arrival. Left out, the link is to where we already are, which is
 * right everywhere else.
 */
export function inviteUrl(code: string, home?: string): string {
  if (home !== undefined && home !== '') return `${home.replace(/\/+$/, '')}/?room=${code}`
  return `${location.origin}${location.pathname}?room=${code}`
}

// ---------------------------------------------------------------------------
// Noticing that this bundle is out of date.
//
// This is here rather than in a game because the room is what makes it matter.
// `admit` refuses to seat two clients on different builds — different builds
// disagree about speeds, sizes and the order things happen in, and come apart
// on the first point with nothing on screen to explain it. So somebody left on
// yesterday's bundle does not get a slightly stale game, they get turned away
// at the door. The library sets that rule; leaving every game to notice on its
// own is the wrong way round.
//
// A generated service-worker registration registers once on load and never asks
// again, so a tab left open never learns about a deploy and a returning visit
// is served the old bundle out of the old worker's precache. Hence: ask on a
// schedule, and tell the player.

export interface UpdateOptions {
  /** What this bundle is. The same string the room is told on connect. */
  readonly build: string
  /**
   * Where the origin says what it is serving right now.
   *
   * Must answer `{"build": "..."}` and must not be precached — the worker is
   * precisely the thing holding the old copy, so asking it is asking the wrong
   * party. Whatever builds the bundle has to write this beside it, stamped the
   * same way `build` is.
   */
  readonly stamp?: string
  /** How often an open tab asks. */
  readonly everyMs?: number
}

/** What the origin is serving right now, or null if it cannot be reached. */
async function deployed(stamp: string): Promise<string | null> {
  try {
    const r = await fetch(stamp, { cache: 'no-store' })
    if (!r.ok) return null
    const j = (await r.json()) as { build?: unknown }
    return typeof j.build === 'string' ? j.build : null
  } catch {
    return null // offline, or the deploy is mid-flight. Ask again later.
  }
}

/**
 * Watch for a newer build and call `onAvailable` once when there is one.
 *
 * Two signals, because either can arrive first. The origin's stamp is the
 * authority — it knows a deploy happened even if this browser's worker has not
 * noticed. And a worker taking over the page means new code is already
 * installed underneath us, which is worth saying immediately.
 *
 * Once, and never again: a player who has been told and carried on does not
 * need telling every minute. Nothing reloads on its own either — being thrown
 * out of a game because a deploy landed is worse than playing a version behind
 * for another minute. What to show them is the game's; `applyUpdate` is what
 * to call when they say yes.
 *
 * Returns a function that stops watching.
 */
export function watchForUpdates(opts: UpdateOptions, onAvailable: () => void): () => void {
  const stamp = opts.stamp ?? '/build.json'
  const everyMs = opts.everyMs ?? 60_000
  let announced = false
  let stopped = false
  const announce = (): void => {
    if (announced || stopped) return
    announced = true
    onAvailable()
  }

  const poll = async (): Promise<void> => {
    const there = await deployed(stamp)
    if (there !== null && there !== opts.build) announce()
  }

  const timers: ReturnType<typeof setInterval>[] = []
  const stop = (): void => {
    stopped = true
    for (const t of timers) clearInterval(t)
  }

  const sw = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  if (sw === undefined) {
    void poll()
    timers.push(setInterval(() => void poll(), everyMs))
    return stop
  }

  // No controller means a first-ever install claiming the page: nothing stale
  // is being replaced, so that is not news.
  const wasControlled = sw.controller !== null
  sw.addEventListener('controllerchange', () => {
    if (wasControlled) announce()
  })

  void sw.ready.then((reg) => {
    const check = (): void => {
      void reg.update().catch(() => {
        // Offline, or the worker is gone. The next check can try again.
      })
      void poll()
    }
    check()
    timers.push(setInterval(check, everyMs))
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check()
      })
    }
  })
  return stop
}

/**
 * Take the newer build.
 *
 * The worker is updated first and only then does the page reload, because a
 * plain reload is served by whatever worker is still installed — which is the
 * old one, and the reload would come back to exactly where it started.
 */
export async function applyUpdate(): Promise<void> {
  const sw = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  if (sw !== undefined) {
    try {
      const reg = await sw.ready
      await reg.update()
    } catch {
      // Nothing to update against; the reload below is still worth a try.
    }
  }
  location.reload()
}
