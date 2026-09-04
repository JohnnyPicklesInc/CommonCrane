# API

Every export, what it is for, and where to read the rest. The source carries
the detail — each module opens with why it exists and what it learned the hard
way — so this is a map rather than a copy of it.

## `@johnnypickles/room`

The room itself. Plain objects: no sockets, no storage, no timers.

### `Room<Who, Settings, Seat>`

What a game talks to. A room says what happened and is handed the decisions to
broadcast. See the README for the shape of a call and the list of decisions.

`Who` is whatever identifies a connection to you. `Settings` is one blob the
host sets for the whole room; `Seat` is one blob each person sets for
themselves. Both are opaque here and validated by your `checkSettings` and
`checkSeat` — five games differed only in what they called those two, and five
different shapes is not five different rules.

| Method | Does |
|---|---|
| `arrive` / `arrived` | Somebody is at the door, or is in. |
| `chairs(who, want)` | Ask for more or fewer chairs on one connection — a couch. |
| `choose(who, chair, raw)` | Validate a seat choice. Returns the seat or `null`. You store it. |
| `propose(who, raw)` | The host proposes settings for the room. |
| `announce(who, on)` | Put the room on the public list, or take it off. |
| `begin(who, places)` | Start a match. `[]` if it will not — see the README. |
| `reopen` / `rematch` | Back to the lobby; or the same terms with a new seed. |
| `input(who, player, from, run)` | What somebody sent. |
| `world` / `fingerprint` / `repair` | Catching up, checking agreement, fixing a client that came apart. |
| `heard(who)` | They are still there. |
| `tick(now)` | Look at the room: silence, staleness, handovers. |
| `take` / `sit` / `stand` | Places changing hands. |
| `settle(now)` | The point everything decided now should land on. |
| `depart(who)` | They are gone. |
| `restore(state, started)` | A room waking up with its memory written down. |
| `refresh(now?)` | The room as it stands, without deciding anything new. |
| `isHost(who, except?)` | Whether this connection is the one that may propose and begin. |

### The parts underneath

`Room` owns the joins between these, which is where every bug that has actually
happened lived. Reach for them directly only if you are building something
other than a room.

| Export | Is |
|---|---|
| `Match` | A match as the room holds it: the transitions rather than the parts. |
| `Lobby` | The room before the game starts, and the settings it carries in. |
| `ContributionLog` | Everything the players have sent, by player and by point. A deterministic sim plus its inputs *is* the game, so replaying this is how a latecomer arrives, how a broken client is repaired, and how a saved match loads. |
| `Presence` | Who has gone quiet, judged on a wall clock — silence, never distance. |
| `Watermark` | The line behind which nothing can change any more. |
| `Fingerprints` | Noticing that two clients have stopped playing the same game. |
| `DecisionLog`, `rollbackClock`, `streamClock` | When a decision takes effect. The one function that has to be right: dated too near and a client cannot reach it, too far and the game feels sluggish. |
| `admit` | Who gets in, and as what. Four decisions, one of them a security rule. |
| `freeChairs`, `hostChair`, `roster`, `resizeChairs` | Questions about who is in the room. |
| `sift` | What to show somebody looking for a room to join. The list is a cache of something the rooms own, never the truth. |
| `makeCode` | A room code somebody can read aloud — no `O` or `0`, no `I` or `1`. |

## `@johnnypickles/room/rollback`

Rollback netcode over your simulation. Every client simulates at full speed and
never waits; a remote input not yet arrived is predicted, and when the truth
contradicts the guess the engine rewinds and resimulates.

- `Rollback<State>` — the engine.
- `RollbackOptions<State>`, `Handover`.
- `Sim<State>` — **what you implement**: `create`, `clone`, `copy`, `pointOf`,
  `step`, `hash`, and optionally `snapshot`/`restore` (together, for
  compaction), `holds` and `automate`. Nothing here knows what a game is.

## `@johnnypickles/room/authority`

One machine simulates, everybody else watches.

- `Authority<State>`, `AuthorityOptions<State>`, `Frame`, `apply`.

## `@johnnypickles/room/follower`

The other side of an authority: holding a world somebody else is simulating.
Two clocks, and keeping them apart is the whole of it — the truth arrives late
and in steps, so it is buffered and rendered a fixed time behind the newest of
it, leaving two worlds either side of the moment being drawn to blend between.

- `Follower<State>`, `FollowerOptions<State>`, `Between`.

## `@johnnypickles/room/client`

The browser side. Kept apart so the room never drags `WebSocket` and `location`
in behind it.

- `Transport<Out, In>` — an interface rather than a class, so a game can play
  with no room at all. Offline is the absence of one, which is tidier than a
  connection that pretends.
- `WsTransport<Out, In>`, `WsOptions`.
- `roomFromUrl()`, `inviteUrl(code, home?)`.
- `createRoom(base?)`, `listRooms(build, base?)` — asking your own HTTP endpoints
  for a new room and for the public list. Defaults are `/api/rooms` and
  `/api/games`; serving them is yours.
- `watchForUpdates(opts, onAvailable)`, `applyUpdate()` — noticing that a new
  build has shipped mid-session, and taking it. What to show somebody is the
  game's; `applyUpdate` is what to call when they say yes.

## `@johnnypickles/room/durable`

Glue for a Cloudflare Durable Object — the only part of the library that knows
what it is running on. The core does not import it and never will, so a game on
another host writes its own thirty lines against the identical `Room` and loses
nothing.

- `Socket`, `Sockets`, `Alarms` — narrow structural interfaces, not Cloudflare
  types, so they can be faked in a test.
- `held(ws, blank)`, `hold(ws, blank, patch)` — read and write what a
  connection holds. The shape is yours; an attachment outlives a deploy.
- `sendTo(ws, msg)`, `broadcast(ctx, msg, except?)`.
- `beat(storage, inMs)` — keeping the alarm alive. Answers a `wake` decision:
  it both clears the fired alarm and schedules the next, so a room that has
  gone quiet stops beating rather than beating forever.
