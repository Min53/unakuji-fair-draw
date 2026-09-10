import type { BoxState } from './types';

/**
 * Storage contract for the core algorithm. `create` and `transact` are the
 * only two operations the pure core needs; everything else (reservations,
 * entitlements, queue, fulfillment ledger, audit) is deliberately NOT part
 * of this interface because those need real relational storage and SQL-level
 * locking to be operationally correct — see adapters/postgres for the
 * production implementation of that extended surface, and README "Which
 * adapter should I use?".
 */
export interface BoxStore {
  /** Rejects if a box with this id already exists. Never upserts. */
  create(state: BoxState): Promise<void>;
  /**
   * Runs `run` against the current state of `boxId` and persists the
   * returned `nextState` atomically with respect to every other `transact`
   * call on the same boxId. If `run` throws, nothing is persisted. The
   * returned promise resolves only after the new state is durably committed.
   */
  transact<T>(boxId: string, run: (current: BoxState) => { nextState: BoxState; value: T }): Promise<T>;
}
