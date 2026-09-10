/**
 * Core domain types shared by the pure algorithm (src/core), the memory
 * adapter, and the PostgreSQL adapter. Public/wire types (PublicBoxView,
 * DrawResult) are intentionally narrow: they never carry the prize assigned
 * to an undrawn ticket. See README "Fairness & privacy invariants".
 */

export interface PrizeInput {
  readonly id: string;
  readonly quantity: number;
}

export interface PrizeSummary {
  readonly id: string;
  readonly quantity: number;
}

export type BoxStatus =
  | 'preparing'
  | 'upcoming'
  | 'on_sale'
  | 'paused'
  | 'sold_out'
  | 'ended'
  | 'canceled';

/** Statuses from which a draw/reservation/queue-join can ever succeed. */
export const OPEN_BOX_STATUSES: readonly BoxStatus[] = ['on_sale'];

export interface CreateBoxInput {
  readonly id: string;
  readonly prizes: readonly PrizeInput[];
  /** Must reference one of `prizes[].id`. Awarded once, to whoever draws the last normal ticket. */
  readonly lastOnePrizeId?: string | undefined;
  /** ISO-8601 or Date. When set, the box starts in `upcoming` and opens automatically at this instant. */
  readonly saleOpensAt?: Date | string | undefined;
  /**
   * Remaining-ticket count at which the box enters the final-segment queue phase.
   * Defaults to `recommendedFinalQueueThreshold(totalTickets)`. 0 disables the queue phase.
   */
  readonly finalQueueThreshold?: number | undefined;
}

export interface TicketAssignment {
  readonly ticketNo: number;
  readonly prizeId: string;
}

export type TicketStatus = 'available' | 'reserved' | 'consumed';

export interface TicketRecord {
  readonly ticketNo: number;
  readonly prizeId: string;
  readonly status: TicketStatus;
  readonly reservedBy?: string | undefined;
  readonly reservedUntil?: string | undefined;
}

/**
 * Full server-side box state. Never serialize this to a public API response —
 * `tickets[].prizeId` for undrawn tickets is exactly the information a fair
 * kuji must keep secret. Use `getPublicBox` to derive the safe public view.
 */
export interface BoxState {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly status: BoxStatus;
  readonly prizes: readonly PrizeSummary[];
  readonly totalTickets: number;
  readonly tickets: readonly TicketRecord[];
  readonly lastOnePrizeId: string | null;
  readonly lastOneAwarded: boolean;
  readonly finalQueueThreshold: number;
  /** SHA-256 commitment over the full ticket assignment, computed at creation. See core/integrity.ts. */
  readonly assignmentCommitment: string;
  readonly saleOpensAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Idempotency ledger keyed by requestId. Present on BoxState (not bolted on
   * by an adapter) because "replay same request -> same result, same
   * request id with different input -> REQUEST_CONFLICT" is a core contract
   * of `draw`/`reserveTickets`, not a storage detail. The PostgreSQL adapter
   * keeps the equivalent ledger in the `purchase_requests` table instead of
   * this field.
   */
  readonly completedRequests: Readonly<Record<string, CompletedRequestRecord>>;
}

export interface CompletedRequestRecord {
  readonly payloadHash: string;
  readonly result: DrawResult | ReservationResult;
}

export interface ReserveTicketsInput {
  readonly requestId: string;
  readonly holder: string;
  readonly ticketNos: readonly number[];
  /** Milliseconds from now until the hold expires. */
  readonly ttlMs: number;
}

export interface ReservationResult {
  readonly boxId: string;
  readonly requestId: string;
  readonly holder: string;
  readonly ticketNos: readonly number[];
  readonly reservedUntil: string;
}

export interface ReleaseReservationInput {
  readonly holder: string;
  readonly ticketNos: readonly number[];
}

export interface DrawInput {
  /** Caller-chosen idempotency key. Same requestId + same ticketNos (any order) replays the cached result. */
  readonly requestId: string;
  /** Opaque id of the authenticated holder making this request; ownership of any entitlement/reservation is checked against it. */
  readonly holder: string;
  readonly ticketNos: readonly number[];
}

export interface DrawResultItem {
  readonly ticketNo: number;
  readonly prizeId: string;
}

export interface DrawResult {
  readonly boxId: string;
  readonly requestId: string;
  readonly items: readonly DrawResultItem[];
  readonly lastOnePrizeId: string | null;
  readonly lastOneAwarded: boolean;
  readonly remaining: number;
}

export interface PublicPrizeRemaining {
  readonly prizeId: string;
  readonly quantity: number;
}

export interface PublicBoxView {
  readonly id: string;
  readonly status: BoxStatus;
  readonly totalTickets: number;
  readonly availableTicketNos: readonly number[];
  readonly remainingByPrize: readonly PublicPrizeRemaining[];
  readonly remaining: number;
  readonly lastOneAwarded: boolean;
  readonly inFinalQueuePhase: boolean;
}
