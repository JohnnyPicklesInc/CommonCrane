// The glue between a room and a Cloudflare Durable Object.
//
// Optional, and at its own entry point, for the same reason `client` is: it is
// the only part of this library that knows what it is running on. The core
// does not import it and never will — the arrow points this way, so a game on
// another host writes its own thirty lines against the identical `Room` and
// loses nothing.
//
// What is here is the part that is genuinely the same every time: reading and
// writing what a connection holds, sending to one or all of them, and keeping
// a heartbeat alive. None of it decides anything.

/** The bits of a hibernatable WebSocket this uses. Kept narrow so it can be faked in a test. */
export interface Socket {
  send(message: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

/** The bits of a Durable Object's state this uses. */
export interface Sockets {
  getWebSockets(): Socket[]
}

/**
 * Read what a connection holds.
 *
 * The shape is the game's entirely, and is deliberately not constrained here.
 * An attachment outlives a deploy — sockets stay connected while the object is
 * replaced — so a library that insisted on its own field names would rename
 * the contents of every room that happened to be occupied at the time.
 *
 * Never null: a socket the runtime handed back with nothing on it is one that
 * has just been accepted, and treating that as an error means a `catch` at
 * every call site instead of an empty room here.
 */
export function held<H>(ws: Socket, blank: H): H {
  const a = ws.deserializeAttachment() as H | null
  return a ?? blank
}

/**
 * Change part of what a connection holds, leaving the rest alone.
 *
 * The read and the merge belong together. Six places in one game were
 * spreading the old attachment over a new one by hand, and an attachment is
 * the only record of who somebody is in a room — spread one field short and a
 * person loses their name, their chairs or the place they are driving,
 * silently, with the type checker perfectly happy because every field is still
 * present.
 */
export function hold<H>(ws: Socket, blank: H, patch: Partial<H>): H {
  const next = { ...held(ws, blank), ...patch }
  ws.serializeAttachment(next)
  return next
}

/**
 * Send to one, and never mind if it has gone.
 *
 * A socket can die between being chosen and being written to, and there is
 * nothing useful to do about it here: the close handler is already on its way.
 * Throwing instead takes the whole message handler down, which loses the other
 * nine people's copy of whatever it was.
 */
export function sendTo(ws: Socket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    // Gone between selection and send.
  }
}

/** Send to everybody, optionally sparing one. Serialised once. */
export function broadcast(ctx: Sockets, msg: unknown, except?: Socket): void {
  const json = JSON.stringify(msg)
  for (const ws of ctx.getWebSockets()) {
    if (ws === except) continue
    try {
      ws.send(json)
    } catch {
      // As above.
    }
  }
}

/** The bits of Durable Object storage the heartbeat uses. */
export interface Alarms {
  getAlarm(): Promise<number | null>
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
}

/**
 * Keep a room's heartbeat running, or stop it.
 *
 * `wake` from a `Room` says when it next wants looking at, and this is the
 * whole of carrying that out. Worth having in one place because the failure is
 * quiet in both directions: a room that stops scheduling stops noticing that
 * anybody has gone silent, and one that never stops runs a timer for ever on a
 * room nobody is in.
 *
 * Only ever sets an alarm when there is not one already, because inside
 * `alarm()` the fired one has already been cleared — so this is also what
 * schedules the next beat.
 */
export async function beat(storage: Alarms, inMs: number | null): Promise<void> {
  if (inMs === null) {
    await storage.deleteAlarm()
    return
  }
  if ((await storage.getAlarm()) === null) await storage.setAlarm(Date.now() + inMs)
}
