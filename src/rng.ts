import { randomInt } from 'node:crypto';
import { kujiError } from './errors';
import type { PrizeInput, TicketAssignment } from './types';

/**
 * Fairness contract (see README "Fairness"): every shuffle uses Node's
 * cryptographically secure `crypto.randomInt`. There is no seed parameter,
 * no injectable RNG, and no fallback to `Math.random()` — if the platform's
 * CSPRNG throws, box creation fails with RNG_FAILURE instead of silently
 * degrading to a weaker generator. Do not add a seed/rng-injection parameter
 * to this module's exports: that would make outcomes reproducible/predictable,
 * which defeats the fairness guarantee this package exists to provide.
 */

/**
 * Uniform random shuffle of `items` in place semantics (returns a new array),
 * using the Fisher-Yates algorithm with crypto.randomInt for every swap index.
 */
export function secureShuffle<T>(items: readonly T[]): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    let j: number;
    try {
      j = randomInt(0, i + 1);
    } catch (cause) {
      throw kujiError('RNG_FAILURE', 'Secure random number generation failed while shuffling ticket assignment.', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const a = result[i] as T;
    const b = result[j] as T;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/**
 * Builds the quantity-preserving pool of prize ids (one entry per unit, e.g.
 * quantity 3 of prize "A" contributes ["A","A","A"]) and shuffles it, then
 * assigns ticket numbers 1..N in shuffled order. This is the entire assignment
 * algorithm: quantities are exactly preserved (it's a permutation of a
 * multiset, not independent per-ticket sampling), and every permutation of
 * the multiset is equally likely because Fisher-Yates on the full pool is
 * itself uniform over permutations.
 */
export function assignTickets(prizes: readonly PrizeInput[]): TicketAssignment[] {
  const pool: string[] = [];
  for (const prize of prizes) {
    for (let i = 0; i < prize.quantity; i++) {
      pool.push(prize.id);
    }
  }
  const shuffled = secureShuffle(pool);
  return shuffled.map((prizeId, index) => ({ ticketNo: index + 1, prizeId }));
}
