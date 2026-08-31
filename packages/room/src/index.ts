// CommonCrane: the room layer under a family of small multiplayer games.
//
// This first cut is deliberately the part with no host in it. Everything here
// is a plain object with no sockets, no storage and no timers, which means it
// runs in a unit test at full speed — and that matters more than it sounds,
// because every bug this library exists to prevent was found by hand against a
// live server after passing several hundred unit tests.
//
// What is here is the arithmetic of a room: what everybody has sent, who has
// gone quiet, and when a decision takes effect. The sockets stay the room's.
//
// `Match` is the one to reach for. The parts below it are each simple and each
// separately tested, and every bug that has actually happened was in the joins
// between them — three fields that had to move together, six statements that
// had to run in one order. `Match` owns those joins: a room says what happened
// and is handed the decisions to broadcast, with no order left to get wrong.

export {
  Match,
  type MatchOptions,
  type BeginOptions,
  type Handover,
  type Lineup,
} from './match.ts'
export { ContributionLog, type At, type LogOptions } from './log.ts'
export { Watermark, type WatermarkOptions } from './watermark.ts'
export { freeChairs, hostChair, roster, resizeChairs, type Seated } from './seating.ts'
export { makeCode, isCode } from './code.ts'
export { admit, type Doorway, type Arrival, type Admission } from './door.ts'
export { sift, type Listed, type Offer, type SiftOptions } from './listing.ts'
export {
  Lobby,
  type LobbyOptions,
  type LobbyView,
  type LobbyState,
  type Check,
} from './lobby.ts'
export { Presence, type PresenceOptions, type PresenceChange } from './presence.ts'
export {
  DecisionLog,
  rollbackClock,
  streamClock,
  type Clock,
  type ClockView,
  type RollbackClockOptions,
} from './schedule.ts'
