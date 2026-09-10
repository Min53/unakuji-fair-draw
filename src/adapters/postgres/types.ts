import type { DrawInput } from '../../types';

export type EntitlementKind = 'single_use' | 'unlimited';
export type EntitlementStatus = 'active' | 'consumed' | 'void' | 'expired';

export interface Entitlement {
  readonly id: string;
  readonly boxId: string;
  readonly holder: string;
  readonly kind: EntitlementKind;
  readonly status: EntitlementStatus;
  readonly source: string | null;
  readonly externalRef: string | null;
  readonly expiresAt: string | null;
}

export interface IssueEntitlementInput {
  readonly boxId: string;
  readonly holder: string;
  readonly kind: EntitlementKind;
  /** Opaque, host-defined tag for reporting/filtering (e.g. "purchase", "event", "admin-grant"). The engine never branches on this value. */
  readonly source?: string | undefined;
  /** Opaque host-defined reference (e.g. an order id) for the host's own reconciliation. Not interpreted by the engine. */
  readonly externalRef?: string | undefined;
  readonly expiresAt?: Date | string | undefined;
  /** If set, rejects with ENTITLEMENT_LIMIT_EXCEEDED once `holder` already has this many active entitlements on `boxId`. */
  readonly maxActivePerHolder?: number | undefined;
}

/**
 * Draw input extended with optional entitlement ids. Entitlements are
 * opt-in: omit `entitlementIds` entirely for integrations that police draw
 * eligibility themselves (see README "Entitlements are opt-in"). When
 * provided, its length must equal `ticketNos.length` — one entitlement per
 * ticket, 1:1.
 */
export interface PgDrawInput extends DrawInput {
  readonly entitlementIds?: readonly string[] | undefined;
}

export type QueueEntryStatus = 'waiting' | 'active' | 'expired' | 'left' | 'canceled' | 'completed' | 'not_queued';

export interface QueueEntry {
  readonly id?: string;
  readonly boxId: string;
  readonly holder: string;
  readonly position?: number;
  readonly status: QueueEntryStatus;
  readonly turnExpiresAt?: string | null;
}

export interface JoinQueueInput {
  readonly requestId: string;
  readonly holder: string;
  readonly turnTtlSeconds: number;
}

export interface ReconcileReport {
  readonly boxId: string;
  readonly healthy: boolean;
  readonly issues: readonly string[];
  readonly ticketCount: number;
  readonly consumedCount: number;
  readonly payoutCount: number;
  readonly commitmentOk: boolean;
}

export interface HolderResultItem {
  readonly ticketNo: number;
  readonly prizeId: string;
  readonly requestId: string;
  readonly drawnAt: string;
}
