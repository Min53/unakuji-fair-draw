export * from './types';
export * from './errors';
export { secureShuffle, assignTickets } from './rng';
export { recommendedFinalQueueThreshold, MAX_TICKETS_PER_BOX, MAX_PRIZE_TYPES_PER_BOX, MAX_TICKETS_PER_DRAW_REQUEST } from './validation';
export { computePayloadHash } from './idempotency';

export { createBox } from './core/createBox';
export type { CreateBoxOutcome } from './core/createBox';
export { draw } from './core/draw';
export type { DrawOutcome } from './core/draw';
export { getPublicBox } from './core/getPublicBox';
export {
  generateAssignmentSalt,
  computeAssignmentCommitment,
  verifyAssignmentCommitment,
} from './core/integrity';

export { reserveTickets, releaseReservation, expireReservations } from './reservations/reserve';
export type { ReserveOutcome } from './reservations/reserve';

export type { BoxStore } from './store';
export { executeDraw } from './executeDraw';
export { executeReserveTickets, executeReleaseReservation } from './executeReserve';

/**
 * NOT exported from the package root: the PostgreSQL adapter
 * (`unakuji-fair-draw/postgres`) and the memory adapter
 * (`unakuji-fair-draw/memory`). Both pull in extra runtime dependencies
 * (`pg`, or just more code than the pure algorithm needs), so they live
 * behind their own subpath exports — see package.json "exports" and the
 * README quick start.
 */
