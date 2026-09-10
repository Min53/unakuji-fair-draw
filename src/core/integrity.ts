import { createHash, randomBytes } from 'node:crypto';
import type { TicketAssignment } from '../types';

/**
 * Lightweight tamper-evidence for a box's ticket assignment, deliberately
 * NOT a Merkle tree or a public zero-knowledge proof (see README "Fairness"
 * — this project intentionally does not build a cryptographic proof
 * platform). At creation, the engine commits to the full assignment with a
 * salted SHA-256 hash. Because no API ever mutates ticket->prize mapping
 * after creation, an operator (or an automated consistency job) can
 * recompute this hash from current storage at any time and compare it to
 * the stored commitment: a mismatch means something wrote to the tickets
 * table outside this engine's own code path.
 */

export function generateAssignmentSalt(): string {
  return randomBytes(32).toString('hex');
}

export function computeAssignmentCommitment(
  boxId: string,
  assignment: readonly TicketAssignment[],
  salt: string
): string {
  const canonical = [...assignment]
    .sort((a, b) => a.ticketNo - b.ticketNo)
    .map((t) => `${t.ticketNo}:${t.prizeId}`)
    .join('|');
  return createHash('sha256').update(boxId).update(' ').update(salt).update(' ').update(canonical).digest('hex');
}

/**
 * Recomputes the commitment from a current assignment snapshot (e.g. read
 * straight from the `tickets` table) and compares it to the value stored at
 * creation time. Use this as a periodic or on-demand consistency check, not
 * as a per-request hot-path call.
 */
export function verifyAssignmentCommitment(
  boxId: string,
  assignment: readonly TicketAssignment[],
  salt: string,
  expectedCommitment: string
): boolean {
  return computeAssignmentCommitment(boxId, assignment, salt) === expectedCommitment;
}
