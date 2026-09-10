import type { BoxState, PublicBoxView, PublicPrizeRemaining } from '../types';

/**
 * Derives the safe public view of a box. This is the ONLY sanctioned way to
 * expose box state externally: it never includes `tickets[].prizeId` for an
 * undrawn ticket, and never includes `completedRequests`. See README
 * "Fairness & privacy invariants".
 */
export function getPublicBox(state: BoxState): PublicBoxView {
  const remainingByPrizeMap = new Map<string, number>();
  for (const prize of state.prizes) remainingByPrizeMap.set(prize.id, 0);

  const availableTicketNos: number[] = [];
  for (const ticket of state.tickets) {
    if (ticket.status !== 'consumed') {
      availableTicketNos.push(ticket.ticketNo);
      remainingByPrizeMap.set(ticket.prizeId, (remainingByPrizeMap.get(ticket.prizeId) ?? 0) + 1);
    }
  }
  availableTicketNos.sort((a, b) => a - b);

  const remainingByPrize: PublicPrizeRemaining[] = state.prizes.map((p) => ({
    prizeId: p.id,
    quantity: remainingByPrizeMap.get(p.id) ?? 0,
  }));

  const remaining = availableTicketNos.length;

  return {
    id: state.id,
    status: state.status,
    totalTickets: state.totalTickets,
    availableTicketNos,
    remainingByPrize,
    remaining,
    lastOneAwarded: state.lastOneAwarded,
    inFinalQueuePhase: state.status === 'on_sale' && state.finalQueueThreshold > 0 && remaining <= state.finalQueueThreshold,
  };
}
