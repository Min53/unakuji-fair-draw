import { kujiError } from '../errors';
import { computePayloadHash } from '../idempotency';
import { assertPositiveInteger, assertValidId } from '../validation';
import type { BoxState, ReleaseReservationInput, ReservationResult, ReserveTicketsInput, TicketRecord } from '../types';

export interface ReserveOutcome {
  readonly nextState: BoxState;
  readonly result: ReservationResult;
}

const MAX_TTL_MS = 30 * 60 * 1000; // 30 minutes — a reference ceiling, hosts can request shorter holds.

function isExpired(ticket: TicketRecord, now: Date): boolean {
  return ticket.reservedUntil !== undefined && new Date(ticket.reservedUntil).getTime() <= now.getTime();
}

/**
 * Places a time-limited hold on one or more available tickets so a holder
 * can complete an out-of-band step (checkout, queue turn, confirmation UI)
 * before committing to `draw`. A hold blocks every other holder from
 * drawing or re-reserving those tickets until it expires or is released;
 * `draw` treats an expired hold as if it were never placed (see core/draw.ts).
 */
export function reserveTickets(state: BoxState, input: ReserveTicketsInput, now: Date = new Date()): ReserveOutcome {
  const requestId = assertValidId(input.requestId, 'requestId');
  const holder = assertValidId(input.holder, 'holder');
  const ttlMs = assertPositiveInteger(input.ttlMs, 'ttlMs');
  if (ttlMs > MAX_TTL_MS) {
    throw kujiError('INVALID_INPUT', `ttlMs exceeds the maximum hold duration of ${MAX_TTL_MS}ms.`, { ttlMs });
  }
  if (!Array.isArray(input.ticketNos) || input.ticketNos.length === 0) {
    throw kujiError('INVALID_INPUT', 'ticketNos must be a non-empty array.');
  }
  const ticketNos = [...new Set(input.ticketNos)].sort((a, b) => a - b);
  const payloadHash = computePayloadHash({ holder, ticketNos, ttlMs });

  const existing = state.completedRequests[requestId];
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw kujiError('REQUEST_CONFLICT', `requestId "${requestId}" was already used with different input.`, { requestId });
    }
    return { nextState: state, result: existing.result as ReservationResult };
  }

  if (state.status !== 'on_sale') {
    throw kujiError('BOX_NOT_ON_SALE', `Box "${state.id}" is not on sale (status=${state.status}).`, { boxId: state.id, status: state.status });
  }

  const ticketByNo = new Map(state.tickets.map((t) => [t.ticketNo, t] as const));
  for (const ticketNo of ticketNos) {
    const ticket = ticketByNo.get(ticketNo);
    if (!ticket) {
      throw kujiError('TICKET_NOT_FOUND', `Ticket ${ticketNo} does not exist in box "${state.id}".`, { boxId: state.id, ticketNo });
    }
    if (ticket.status === 'consumed') {
      throw kujiError('TICKET_UNAVAILABLE', `Ticket ${ticketNo} has already been drawn.`, { boxId: state.id, ticketNo });
    }
    if (ticket.status === 'reserved' && ticket.reservedBy !== holder && !isExpired(ticket, now)) {
      throw kujiError('RESERVATION_CONFLICT', `Ticket ${ticketNo} is already held by another holder.`, { boxId: state.id, ticketNo });
    }
  }

  const reservedUntil = new Date(now.getTime() + ttlMs).toISOString();
  const targetNos = new Set(ticketNos);
  const nextTickets = state.tickets.map((t): TicketRecord =>
    targetNos.has(t.ticketNo)
      ? { ticketNo: t.ticketNo, prizeId: t.prizeId, status: 'reserved', reservedBy: holder, reservedUntil }
      : t
  );

  const result: ReservationResult = { boxId: state.id, requestId, holder, ticketNos, reservedUntil };

  const nextState: BoxState = {
    ...state,
    tickets: nextTickets,
    completedRequests: { ...state.completedRequests, [requestId]: { payloadHash, result } },
    updatedAt: now.toISOString(),
  };

  return { nextState, result };
}

/** Releases a hold early. No-op (not an error) on tickets the holder doesn't currently hold, so callers can release optimistically. */
export function releaseReservation(state: BoxState, input: ReleaseReservationInput, now: Date = new Date()): BoxState {
  const holder = assertValidId(input.holder, 'holder');
  const targetNos = new Set(input.ticketNos);
  const nextTickets = state.tickets.map((t): TicketRecord => {
    if (targetNos.has(t.ticketNo) && t.status === 'reserved' && t.reservedBy === holder) {
      return { ticketNo: t.ticketNo, prizeId: t.prizeId, status: 'available' };
    }
    return t;
  });
  return { ...state, tickets: nextTickets, updatedAt: now.toISOString() };
}

/** Sweeps every expired hold back to `available`. Safe to call on any schedule; a no-op when nothing has expired. */
export function expireReservations(state: BoxState, now: Date = new Date()): BoxState {
  let changed = false;
  const nextTickets = state.tickets.map((t): TicketRecord => {
    if (t.status === 'reserved' && isExpired(t, now)) {
      changed = true;
      return { ticketNo: t.ticketNo, prizeId: t.prizeId, status: 'available' };
    }
    return t;
  });
  if (!changed) return state;
  return { ...state, tickets: nextTickets, updatedAt: now.toISOString() };
}
