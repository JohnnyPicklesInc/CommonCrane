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
| `adopt(state, match, now)` | Become the room, on a machine that was only ever a client of it. Both halves in one call, and validated before anything is touched. |
| `refresh(now?)` | The room as it stands, without deciding anything new. |
| `isHost(who, except?)` | Whether this connection is the one that may propose and begin. |

### The parts underneath

`Room` owns the joins between these, which is where every bug that has actually
happened lived. Reach for them directly only if you are building something
other than a room.

| Export | Is |
|---|---|
| `Match` | A match as the room holds it: the transitions rather than the parts. `begin`, `resume` and `adopt` are three different ways in: from nothing, from a room that forgot, and from another machine's `catchup()`. |
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
| `gather`, `filling`, `startsIn` | Putting strangers who have no room code into the same room, and deciding when it has waited long enough. Where the answer is kept — and what makes it single-threaded — is the host's. |

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

## `@johnnypickles/room/host`

`durable` with the Cloudflare taken out of it. The same five things every host
needs — read what a connection holds, change one field of it, send to one, send
to all but one, look again no later than a deadline — against interfaces you
supply, so a peer-hosted game gets them with a Steam identity where the socket
was.

- `Peers<Who, Held>` — the four operations a host supplies: `all()`,
  `attachment(who)`, `attach(who, held)`, `send(who, payload)`. Membership is
  asked for, never kept, for the same reason `Room` asks: on a host whose
  connections outlive its memory, the connections are the only record that
  survives.
- `Host` — `held`/`hold`, `sendTo`/`broadcast` (serialised once, because an
  input echo is the hot path), and `carry(decisions, from?)`.
- `carry` takes the four decisions that are about being a host — `remember`,
  `wake`, `listed`, `recycle` — and hands everything else to your `say`. The
  other twelve are things to tell people, and what to call them is your
  protocol's business. The four are passed on to `say` as well rather than
  swallowed.
- `heartbeat(look)` — `beat` over plain timers, for a host that stays in
  memory. Brings a pending wake forward when asked for sooner and leaves one
  already sooner alone.

## `@johnnypickles/room/steam`

`client` for a game whose room lives inside one of the players. Imports no SDK
and cannot: `Messages` is four operations, supplied by whatever process actually
holds the Steam API — so this tests at full speed against a fake and is safe in
a browser bundle that will never call it.

- `Messages` — `me`, `send`, `drain`, `accept`, `close`. Deliberately not the
  lobby half; a transport has no business knowing how a room was found.
- `Id` — a Steam identity as decimal digits. A string because every steamID64
  is larger than `Number.MAX_SAFE_INTEGER`, so one carried as a number is
  silently the wrong person.
- `CONTROL` / `INPUT` — the careful channel and the hot one. Say which of your
  messages are droppable with `unreliable`; left out, everything is reliable,
  which is the answer that is merely slow rather than wrong.
- `SteamTransport` — the client end, one peer, implementing `Transport`.
  `pump()` is yours to call: receive is a poll, your game already has a loop at
  that rate, and how often you call it *is* the inbound latency. `onRefused`
  hears about a message Steam would not take, which is how this fails — by
  size, on a catchup.
- `loopback()` — the two ends of a room and a client in one process, so a listen
  host plays through a transport like everybody else. Delivery is deferred, and
  that is the substance of it: a room part-way through a list of decisions is
  not re-entrant.
- `steamPeers()` — `Peers` for `Host` over Steam identities, plus the pump that
  feeds it. Give it `self` and the host's own copy goes down the loopback
  instead of asking Valve to deliver a message to this machine.

**Exactly one thing in a process may drain a channel.** Two drainers steal from
each other silently, and what goes missing is half of everybody's input. On a
joiner that is the transport; on a host it is the peer pump.

Finding a room, and being found — the same four jobs `client` does against your
own HTTP endpoints, against Valve's versions of them:

- `Lobbies` — the lobby half, and a separate interface from `Messages` because a
  transport has no business knowing how a room was found. Asynchronous
  throughout: none of it is on a hot path, so there is no reason to pretend a
  request to another process is instant.
- `LobbyId` — also the room's *code* on Steam. A four-character code exists to
  be read aloud, and a Steam invite is a button in the overlay, so `makeCode`
  has no job here — and an offer somebody clicks is directly joinable rather
  than needing a lookup.
- `openLobby(lobbies, {build, max, announce?})` — the counterpart of
  `createRoom`, and it stamps the build *before* the lobby is joinable. Listed
  first, other builds offer it to their players for as long as the next call
  takes, and every one of them is turned away at the door.
- `publish(lobbies, lobby, entry)` — give this to `Host` as its `list`. Answers a
  `listed` decision: the card and whether Valve offers the lobby move together.
  `null` comes off the board without turning anybody out of the lobby.
- `browse(lobbies, {build, now})` — the counterpart of `listRooms`, returning the
  same `Offer[]` so an existing menu goes on working. Every lobby's data is read
  concurrently, because Steam's list call cannot filter on it. Empty rather than
  throwing when the list cannot be had.
- `invitedTo(argv)` — the counterpart of `roomFromUrl`, reading
  `+connect_lobby <id>`. Digits only: it is somebody else's text on a command
  line. Accepted while the game is already running, the same thing arrives as an
  SDK callback instead, which is the host's to listen for.

Steam's lobby list is the truth rather than a cache of it — Valve removes a lobby
when its owner goes — so the staleness half of `sift` is inert here. The build
filter is not: on Steam a wrong build means a stale depot rather than a stale tab,
which is likelier, because Steam updates in the background and a running game does
not.
