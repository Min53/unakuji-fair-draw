import { kujiError } from '../errors';
import { computePayloadHash } from '../idempotency';
import { validateDrawInput } from '../validation';
import type { BoxState, DrawInput, DrawResult, DrawResultItem, TicketRecord } from '../types';

export interface DrawOutcome {
  readonly nextState: BoxState;
  readonly result: DrawResult;
}

function isReservationExpired(ticket: TicketRecord, now: Date): boolean {
  return ticket.reservedUntil !== undefined && new Date(ticket.reservedUntil).getTime() <= now.getTime();
}

/**
 * Pure, immutable state transition: draws `input.ticketNos` from `state` for
 * `input.holder`. Never mutates `state`. All-or-nothing: if any requested
 * ticket is unavailable, the whole call throws and `state` is returned
 * untouched by the caller (this function simply never produces a partial
 * nextState). Idempotent on (requestId): a replay with the same holder+
 * ticketNos returns the original result; a requestId reused with different
 * input throws REQUEST_CONFLICT.
 */
export function draw(state: BoxState, input: DrawInput, now: Date = new Date()): DrawOutcome {
  const { requestId, holder, ticketNos } = validateDrawInput(input);
  const payloadHash = computePayloadHash({ holder, ticketNos });

  const existing = state.completedRequests[requestId];
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw kujiError('REQUEST_CONFLICT', `requestId "${requestId}" was already used with a different holder/ticketNos.`, { requestId });
    }
    return { nextState: state, result: existing.result as DrawResult };
  }

  if (state.status !== 'on_sale') {
    throw kujiError('BOX_NOT_ON_SALE', `Box "${state.id}" is not on sale (status=${state.status}).`, { boxId: state.id, status: state.status });
  }

  const ticketByNo = new Map(state.tickets.map((t) => [t.ticketNo, t] as const));
  const targets: TicketRecord[] = [];
  for (const ticketNo of ticketNos) {
    const ticket = ticketByNo.get(ticketNo);
    if (!ticket) {
      throw kujiError('TICKET_NOT_FOUND', `Ticket ${ticketNo} does not exist in box "${state.id}".`, { boxId: state.id, ticketNo });
    }
    if (ticket.status === 'consumed') {
      throw kujiError('TICKET_UNAVAILABLE', `Ticket ${ticketNo} has already been drawn.`, { boxId: state.id, ticketNo });
    }
    if (ticket.status === 'reserved' && ticket.reservedBy !== holder && !isReservationExpired(ticket, now)) {
      throw kujiError('TICKET_UNAVAILABLE', `Ticket ${ticketNo} is held by another holder until ${ticket.reservedUntil}.`, {
        boxId: state.id,
        ticketNo,
      });
    }
    targets.push(ticket);
  }

  const consumedNos = new Set(ticketNos);
  const nextTickets = state.tickets.map((t): TicketRecord =>
    consumedNos.has(t.ticketNo) ? { ticketNo: t.ticketNo, prizeId: t.prizeId, status: 'consumed' } : t
  );
  const remaining = nextTickets.reduce((n, t) => (t.status === 'consumed' ? n : n + 1), 0);

  const items: DrawResultItem[] = targets.map((t) => ({ ticketNo: t.ticketNo, prizeId: t.prizeId }));

  const lastOneJustAwarded = state.lastOnePrizeId !== null && !state.lastOneAwarded && remaining === 0;

  const result: DrawResult = {
    boxId: state.id,
    requestId,
    items,
    lastOnePrizeId: lastOneJustAwarded ? state.lastOnePrizeId : null,
    lastOneAwarded: state.lastOneAwarded || lastOneJustAwarded,
    remaining,
  };

  const nextState: BoxState = {
    ...state,
    status: remaining === 0 ? 'sold_out' : state.status,
    tickets: nextTickets,
    lastOneAwarded: state.lastOneAwarded || lastOneJustAwarded,
    completedRequests: { ...state.completedRequests, [requestId]: { payloadHash, result } },
    updatedAt: now.toISOString(),
  };

  return { nextState, result };
}
