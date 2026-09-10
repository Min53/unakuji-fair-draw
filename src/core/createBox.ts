import { assignTickets } from '../rng';
import { recommendedFinalQueueThreshold, validateCreateBoxInput } from '../validation';
import { computeAssignmentCommitment, generateAssignmentSalt } from './integrity';
import type { BoxState, CreateBoxInput, TicketRecord } from '../types';

export interface CreateBoxOutcome {
  readonly state: BoxState;
  /** Persist alongside the box if you want verifyAssignmentIntegrity to work later; not a secret. */
  readonly assignmentSalt: string;
}

/**
 * Pure box-creation: validates input, performs the quantity-preserving
 * secure shuffle, and returns an immutable BoxState plus its integrity salt.
 * Does not touch any storage — see adapters/memory.ts and
 * adapters/postgres/createBox.ts for the persisted versions.
 */
export function createBox(input: CreateBoxInput, now: Date = new Date()): CreateBoxOutcome {
  const validated = validateCreateBoxInput(input);
  const assignment = assignTickets(validated.prizes);
  const assignmentSalt = generateAssignmentSalt();
  const assignmentCommitment = computeAssignmentCommitment(validated.id, assignment, assignmentSalt);

  const tickets: TicketRecord[] = assignment.map((a) => ({
    ticketNo: a.ticketNo,
    prizeId: a.prizeId,
    status: 'available',
  }));

  const nowIso = now.toISOString();
  const totalTickets = tickets.length;

  const state: BoxState = {
    schemaVersion: 1,
    id: validated.id,
    status: validated.saleOpensAt ? 'upcoming' : 'preparing',
    prizes: validated.prizes,
    totalTickets,
    tickets,
    lastOnePrizeId: validated.lastOnePrizeId,
    lastOneAwarded: false,
    finalQueueThreshold: validated.finalQueueThreshold ?? recommendedFinalQueueThreshold(totalTickets),
    assignmentCommitment,
    saleOpensAt: validated.saleOpensAt,
    createdAt: nowIso,
    updatedAt: nowIso,
    completedRequests: {},
  };

  return { state, assignmentSalt };
}
