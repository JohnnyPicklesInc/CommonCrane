// CommonCrane: the room layer under a family of small multiplayer games.
//
// This first cut is deliberately the part with no host in it. Everything here
// is a plain object with no sockets, no storage and no timers, which means it
// runs in a unit test at full speed — and that matters more than it sounds,
// because every bug this library exists to prevent was found by hand against a
// live server after passing several hundred unit tests.
//
// What is here is the arithmetic of a room: what everybody has sent, who has
// gone quiet, and when a decision takes effect. The sockets come later.

export { ContributionLog, type At, type LogOptions } from './log.ts'
export { Presence, type PresenceOptions, type PresenceChange } from './presence.ts'
export {
  DecisionLog,
  rollbackClock,
  streamClock,
  type Clock,
  type ClockView,
  type RollbackClockOptions,
} from './schedule.ts'
