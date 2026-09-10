import type { Pool, QueryResultRow } from 'pg';
import { computeAssignmentCommitment, generateAssignmentSalt } from '../../core/integrity';
import { kujiError } from '../../errors';
import { computePayloadHash } from '../../idempotency';
import { assignTickets } from '../../rng';
import type {
  CreateBoxInput,
  DrawResult,
  PublicBoxView,
  ReleaseReservationInput,
  ReservationResult,
  ReserveTicketsInput,
} from '../../types';
import {
  assertPositiveInteger,
  assertValidId,
  MAX_TICKETS_PER_DRAW_REQUEST,
  recommendedFinalQueueThreshold,
  validateCreateBoxInput,
} from '../../validation';
import { translatePgError } from './pgError';
import type {
  Entitlement,
  HolderResultItem,
  IssueEntitlementInput,
  JoinQueueInput,
  PgDrawInput,
  QueueEntry,
  ReconcileReport,
} from './types';

function toIso(value: Date | string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapEntitlementRow(row: {
  id: string;
  boxId: string;
  holder: string;
  kind: string;
  status: string;
  source: string | null;
  externalRef: string | null;
  expiresAt: string | null;
}): Entitlement {
  return row as Entitlement;
}

/**
 * Production storage/concurrency implementation: every public method here is
 * a thin wrapper around one call to a `kuji_*` SQL function in db/002-004,
 * so the transactional/locking behavior lives in one place (SQL) instead of
 * being re-implemented (and potentially getting out of sync) in two
 * languages. See db/002_functions.sql header for the locking strategy and
 * README "Concurrency model".
 *
 * This class never opens or manages its own transaction across multiple
 * calls: each method is exactly one round trip, and the SQL function itself
 * is the transaction boundary (Postgres wraps every function call in an
 * implicit transaction when none is already open). If you need to combine a
 * draw with a host-side side effect (e.g. deducting payment) atomically, see
 * README "Combining a draw with your own side effects in one transaction".
 */
export class PostgresKujiEngine {
  constructor(private readonly pool: Pool) {}

  private async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
    try {
      const res = await this.pool.query<T>(sql, params);
      return res.rows;
    } catch (err) {
      translatePgError(err);
    }
  }

  private async one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[]): Promise<T> {
    const rows = await this.query<T>(sql, params);
    const row = rows[0];
    if (!row) {
      throw kujiError('INVALID_STATE', 'Expected exactly one row from a scalar-returning function but got none.');
    }
    return row;
  }

  // -- Box lifecycle ---------------------------------------------------------

  async createBox(input: CreateBoxInput, _now: Date = new Date()): Promise<PublicBoxView> {
    const validated = validateCreateBoxInput(input);
    const assignment = assignTickets(validated.prizes);
    const salt = generateAssignmentSalt();
    const commitment = computeAssignmentCommitment(validated.id, assignment, salt);
    const finalQueueThreshold = validated.finalQueueThreshold ?? recommendedFinalQueueThreshold(assignment.length);

    const row = await this.one<{ result: PublicBoxView }>(
      `SELECT kuji_create_box($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7,$8) AS result`,
      [validated.id, JSON.stringify(validated.prizes), JSON.stringify(assignment), commitment, salt, validated.lastOnePrizeId, validated.saleOpensAt, finalQueueThreshold]
    );
    return row.result;
  }

  async openBox(boxId: string, actor?: string): Promise<PublicBoxView> {
    const row = await this.one<{ result: PublicBoxView }>(`SELECT kuji_open_box($1,$2) AS result`, [boxId, actor ?? null]);
    return row.result;
  }

  async scheduleBoxOpen(boxId: string, opensAt: Date | string, actor?: string): Promise<PublicBoxView> {
    const row = await this.one<{ result: PublicBoxView }>(`SELECT kuji_schedule_box_open($1,$2,$3) AS result`, [
      boxId,
      toIso(opensAt),
      actor ?? null,
    ]);
    return row.result;
  }

  /** Call on whatever schedule your host already runs (cron, worker, setInterval) — see README "Background jobs". */
  async openScheduledBoxes(): Promise<number> {
    const row = await this.one<{ result: number }>(`SELECT kuji_open_scheduled_boxes() AS result`, []);
    return row.result;
  }

  async pauseBox(boxId: string, actor: string, reason?: string): Promise<PublicBoxView> {
    const row = await this.one<{ result: PublicBoxView }>(`SELECT kuji_pause_box($1,$2,$3) AS result`, [boxId, actor, reason ?? null]);
    return row.result;
  }

  async resumeBox(boxId: string, actor: string): Promise<PublicBoxView> {
    const row = await this.one<{ result: PublicBoxView }>(`SELECT kuji_resume_box($1,$2) AS result`, [boxId, actor]);
    return row.result;
  }

  async cancelBox(boxId: string, actor: string, reason?: string, allowRealSales = false): Promise<PublicBoxView> {
    const row = await this.one<{ result: PublicBoxView }>(`SELECT kuji_cancel_box($1,$2,$3,$4) AS result`, [
      boxId,
      actor,
      reason ?? null,
      allowRealSales,
    ]);
    return row.result;
  }

  /** Force-close a box regardless of remaining tickets (e.g. an operationally deadlocked queue). Existing results remain queryable. */
  async closeBox(boxId: string, actor: string, reason?: string): Promise<PublicBoxView> {
    const row = await this.one<{ result: PublicBoxView }>(`SELECT kuji_close_box($1,$2,$3) AS result`, [boxId, actor, reason ?? null]);
    return row.result;
  }

  async getPublicBox(boxId: string): Promise<PublicBoxView> {
    const row = await this.one<{ result: PublicBoxView }>(`SELECT kuji_public_box($1) AS result`, [boxId]);
    return row.result;
  }

  // -- Draw --------------------------------------------------------------

  /**
   * Entitlements are opt-in: omit `entitlementIds` for integrations that
   * police draw eligibility themselves. When provided, its length must equal
   * `ticketNos.length` (one entitlement pays for exactly one ticket);
   * pairing survives ticketNos being reordered/deduped for idempotency.
   */
  async draw(boxId: string, input: PgDrawInput): Promise<DrawResult> {
    assertValidId(boxId, 'boxId');
    const requestId = assertValidId(input.requestId, 'requestId');
    const holder = assertValidId(input.holder, 'holder');
    if (!Array.isArray(input.ticketNos) || input.ticketNos.length === 0) {
      throw kujiError('INVALID_INPUT', 'ticketNos must be a non-empty array.');
    }
    if (input.ticketNos.length > MAX_TICKETS_PER_DRAW_REQUEST) {
      // Without this cap, one request could hold the box's FOR UPDATE lock
      // (see db/002_functions.sql) for as long as it takes to process an
      // arbitrarily large ticket array, starving every other draw/reserve/
      // joinQueue call on the same box — a griefing vector, not a fairness
      // or correctness bug, but worth closing off. Found by independent
      // adversarial review; the memory adapter already enforced this via
      // validateDrawInput but this adapter has its own input handling (for
      // ticketNo<->entitlementId pairing) and had drifted from it.
      throw kujiError('INVALID_INPUT', `ticketNos exceeds the maximum of ${MAX_TICKETS_PER_DRAW_REQUEST} per request.`);
    }
    const entitlementIdsInput = input.entitlementIds ? [...input.entitlementIds] : null;
    if (entitlementIdsInput && entitlementIdsInput.length !== input.ticketNos.length) {
      throw kujiError('ENTITLEMENT_TICKET_MISMATCH', 'entitlementIds length must match ticketNos length (one entitlement per ticket).');
    }

    // Pair each ticketNo with its entitlementId BEFORE sorting/deduping, so
    // a caller-supplied order never matters but pairing is never scrambled.
    const seen = new Set<number>();
    const pairs: { ticketNo: number; entitlementId: string | null }[] = [];
    input.ticketNos.forEach((ticketNo, i) => {
      if (typeof ticketNo !== 'number' || !Number.isInteger(ticketNo) || ticketNo <= 0) {
        throw kujiError('INVALID_INPUT', `ticketNos[${i}] must be a positive integer.`);
      }
      if (seen.has(ticketNo)) {
        throw kujiError('INVALID_INPUT', `Duplicate ticket number ${ticketNo} in ticketNos.`);
      }
      seen.add(ticketNo);
      pairs.push({ ticketNo, entitlementId: entitlementIdsInput ? (entitlementIdsInput[i] ?? null) : null });
    });
    pairs.sort((a, b) => a.ticketNo - b.ticketNo);

    const ticketNos = pairs.map((p) => p.ticketNo);
    const entitlementIds = entitlementIdsInput ? pairs.map((p) => p.entitlementId) : null;
    const payloadHash = computePayloadHash({ holder, ticketNos, entitlementIds });

    const row = await this.one<{ result: DrawResult }>(`SELECT kuji_draw($1,$2,$3,$4::int[],$5::uuid[],$6) AS result`, [
      boxId,
      holder,
      requestId,
      ticketNos,
      entitlementIds,
      payloadHash,
    ]);
    return row.result;
  }

  async getResult(boxId: string, holder: string, requestId: string): Promise<DrawResult | null> {
    const row = await this.one<{ result: DrawResult | null }>(`SELECT kuji_get_result($1,$2,$3) AS result`, [boxId, holder, requestId]);
    return row.result;
  }

  async getHolderResults(boxId: string, holder: string): Promise<HolderResultItem[]> {
    const row = await this.one<{ result: HolderResultItem[] }>(`SELECT kuji_get_holder_results($1,$2) AS result`, [boxId, holder]);
    return row.result;
  }

  // -- Reservations --------------------------------------------------------

  async reserveTickets(boxId: string, input: ReserveTicketsInput): Promise<ReservationResult> {
    const requestId = assertValidId(input.requestId, 'requestId');
    const holder = assertValidId(input.holder, 'holder');
    if (!Array.isArray(input.ticketNos) || input.ticketNos.length === 0) {
      throw kujiError('INVALID_INPUT', 'ticketNos must be a non-empty array.');
    }
    const ttlMs = assertPositiveInteger(input.ttlMs, 'ttlMs');
    const ticketNos = [...new Set(input.ticketNos)].sort((a, b) => a - b);
    const payloadHash = computePayloadHash({ holder, ticketNos, ttlMs });

    const row = await this.one<{ result: ReservationResult }>(`SELECT kuji_reserve_tickets($1,$2,$3,$4::int[],$5::bigint,$6) AS result`, [
      boxId,
      holder,
      requestId,
      ticketNos,
      ttlMs,
      payloadHash,
    ]);
    return row.result;
  }

  async releaseReservation(boxId: string, input: ReleaseReservationInput): Promise<void> {
    const holder = assertValidId(input.holder, 'holder');
    await this.query(`SELECT kuji_release_reservation($1,$2,$3::int[])`, [boxId, holder, [...input.ticketNos]]);
  }

  /** Sweeps expired holds back to available. Safe on any schedule; a no-op when nothing has expired. Pass no boxId to sweep every box. */
  async expireReservations(boxId?: string, limit = 5000): Promise<number> {
    const row = await this.one<{ result: number }>(`SELECT kuji_expire_reservations($1,$2) AS result`, [boxId ?? null, limit]);
    return row.result;
  }

  // -- Entitlements --------------------------------------------------------

  async issueEntitlement(input: IssueEntitlementInput): Promise<Entitlement> {
    const boxId = assertValidId(input.boxId, 'boxId');
    const holder = assertValidId(input.holder, 'holder');
    const row = await this.one<{ result: Entitlement }>(`SELECT kuji_issue_entitlement($1,$2,$3,$4,$5,$6,$7) AS result`, [
      boxId,
      holder,
      input.kind,
      input.source ?? null,
      input.externalRef ?? null,
      toIso(input.expiresAt),
      input.maxActivePerHolder ?? null,
    ]);
    return mapEntitlementRow(row.result as never);
  }

  async cancelEntitlement(entitlementId: string, actor: string, reason?: string): Promise<Entitlement> {
    const row = await this.one<{ result: Entitlement }>(`SELECT kuji_cancel_entitlement($1,$2,$3) AS result`, [
      entitlementId,
      actor,
      reason ?? null,
    ]);
    return row.result;
  }

  // -- Final-segment queue --------------------------------------------------

  async joinQueue(boxId: string, input: JoinQueueInput): Promise<QueueEntry> {
    const requestId = assertValidId(input.requestId, 'requestId');
    const holder = assertValidId(input.holder, 'holder');
    const turnTtlSeconds = assertPositiveInteger(input.turnTtlSeconds, 'turnTtlSeconds');
    const payloadHash = computePayloadHash({ holder, turnTtlSeconds });
    const row = await this.one<{ result: QueueEntry }>(`SELECT kuji_join_queue($1,$2,$3,$4,$5) AS result`, [
      boxId,
      holder,
      requestId,
      turnTtlSeconds,
      payloadHash,
    ]);
    return row.result;
  }

  async leaveQueue(boxId: string, holder: string): Promise<QueueEntry> {
    const row = await this.one<{ result: QueueEntry }>(`SELECT kuji_leave_queue($1,$2) AS result`, [boxId, holder]);
    return row.result;
  }

  async getQueueStatus(boxId: string, holder: string): Promise<QueueEntry> {
    const row = await this.one<{ result: QueueEntry }>(`SELECT kuji_queue_status($1,$2) AS result`, [boxId, holder]);
    return row.result;
  }

  /** Expires stale turns and promotes the next holder for every box (or one box). Not required for correctness — kuji_draw always re-validates — only for keeping the queue moving promptly. */
  async advanceQueue(boxId?: string, limit = 1000): Promise<number> {
    const row = await this.one<{ result: number }>(`SELECT kuji_advance_queue($1,$2) AS result`, [boxId ?? null, limit]);
    return row.result;
  }

  // -- Recovery & consistency ------------------------------------------------

  async reconcile(boxId: string): Promise<ReconcileReport> {
    const row = await this.one<{ result: ReconcileReport }>(`SELECT kuji_reconcile($1) AS result`, [boxId]);
    return row.result;
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

export type {
  Entitlement,
  EntitlementKind,
  EntitlementStatus,
  HolderResultItem,
  IssueEntitlementInput,
  JoinQueueInput,
  PgDrawInput,
  QueueEntry,
  QueueEntryStatus,
  ReconcileReport,
} from './types';
