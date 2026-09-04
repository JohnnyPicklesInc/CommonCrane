# CommonCrane

The room under a multiplayer game: who is here, who has gone quiet, what
everybody has sent, and when a decision takes effect.

It is the part five small games each wrote for themselves before it was worth
writing once. Deterministic simulation is yours; this is everything around it.

```
npm install @johnnypickles/room
```

No dependencies. The core has no sockets, no storage and no timers in it, so it
runs in a unit test at full speed and on whatever host you like.

## A room, start to finish

Nothing below needs a server, a browser or a build step. It runs under plain
node as it stands.

```js
import { Room, streamClock } from '@johnnypickles/room'

// The room asks who is here rather than keeping the list, so this is yours.
const members = []

const room = new Room({
  capacity: 4,          // chairs in the room
  roster: 2,            // most places a match here is laid out for
  clock: streamClock(),
  silenceMs: 10_000,    // how long somebody may say nothing before they are quiet
  recall: 8,            // how many disagreement points to remember
  heartbeatMs: 30_000,  // how often an idle room should be looked at

  // Your game's data, and your rules about it. The room stores what comes
  // back and never looks inside.
  settings: { board: 'standard' },
  checkSettings: (raw) =>
    raw && typeof raw === 'object' && typeof raw.board === 'string'
      ? { board: raw.board }
      : null,
  checkSeat: (raw) => (raw === 'white' || raw === 'black' ? raw : null),

  members: () => members,
})

// Somebody connects. `who` is whatever you use for a connection.
members.push({ who: 'a', name: 'Ada', chairs: [0], players: [], seats: [] })
room.arrived('a', 'Ada', Date.now())        // → lobby, listed, wake

members.push({ who: 'b', name: 'Bo', chairs: [1], players: [], seats: [] })
room.arrived('b', 'Bo', Date.now())         // → lobby, listed, wake

// The room validates a choice. You are what remembers it.
members[0].seats = [room.choose('a', 0, 'white')]   // → 'white'
members[1].seats = [room.choose('b', 1, 'black')]   // → 'black'
room.choose('b', 1, 'purple')                       // → null, refused

room.begin('a', 2, Date.now())              // → remember, begun, listed, wake
```

## The two things to understand

**You own the membership; the room asks for it.** Every call takes a `who` and
the room calls your `members()` to find out what that means. It keeps no copy.
This is not ceremony — a room whose memory can be lost while its connections
outlive it has to keep membership on the connections themselves, so a library
holding it would be holding something already stale.

A member is:

```js
{ who, name, chairs: [0], players: [], seats: [undefined] }
```

`chairs` are places in the room, `players` are places in the running match, and
`seats` is your own blob per chair — whatever `checkSeat` returns.

**Every method returns decisions; applying them is your job.** The room decides
and hands you a list. It sends nothing, stores nothing and sets no timers.

```js
for (const d of room.arrived('a', 'Ada', Date.now())) {
  switch (d.kind) {
    case 'lobby':    broadcast(d.view); break
    case 'wake':     setTimeout(beat, d.inMs); break
    case 'listed':   /* put the room on your public list */ break
    case 'remember': /* write d.state down, it survives a restart */ break
  }
}
```

The full set: `refuse` `seated` `watching` `arrived` `left` `lobby` `begun`
`handovers` `lineup` `drives` `catchup` `disagreed` `listed` `remember` `wake`
`recycle`. Each is documented where it is declared, in
[`src/room.ts`](packages/room/src/room.ts).

A method that returns `[]` decided nothing. `begin()` does this when the caller
is not the host, when a match is already running, when `places` is outside the
roster, or when nobody has chosen a seat — a chair whose person has not chosen
is left out of the match entirely and starts as a watcher.

## Entry points

Everything optional is behind its own import, so the core never drags a host or
a browser in behind it.

| Import | For |
|---|---|
| `@johnnypickles/room` | The room. Plain objects, no host, no clock of its own. |
| `@johnnypickles/room/rollback` | Rollback netcode: every client simulates, rewinds when a guess is contradicted. |
| `@johnnypickles/room/authority` | One machine simulates and sends out what happened. |
| `@johnnypickles/room/follower` | The other side of an authority: holding a world somebody else simulates. |
| `@johnnypickles/room/client` | Browser side — a WebSocket transport, invite URLs, update watching. |
| `@johnnypickles/room/durable` | Glue for a Cloudflare Durable Object. The only host adapter that exists; writing another is about thirty lines. |

See [docs/api.md](docs/api.md) for what each one exports.

## Choosing a netcode

`rollback` and `authority` are alternatives, and the trade is the whole design.

**Rollback** has every client simulate every player and rewind when the truth
contradicts a guess. Nobody ever waits for the network. It costs N clients each
simulating N players every point, again for every rewind, and it stops dead
whenever any one peer falls more than a window behind — the wait is a maximum
over peers.

**Authority** has exactly one machine simulate. Cheaper, and one slow peer slows
only themselves, but everybody else is seeing the past.

Both want a `Sim<State>` from you — `create`, `clone`, `copy`, `pointOf`,
`step`, `hash`, and optionally `snapshot`/`restore` for compaction. Nothing in
either knows what a game is.

## Maintaining this

Releasing, pinning consumers and publishing: [docs/releasing.md](docs/releasing.md).

## License

MIT — see [LICENSE](LICENSE).
