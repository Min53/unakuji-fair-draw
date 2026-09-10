import { kujiError } from './errors';
import type { CreateBoxInput, DrawInput, PrizeInput } from './types';

/** Upper bound on tickets per box. A reference-implementation safety valve, not a business rule — raise it if your use case needs more. */
export const MAX_TICKETS_PER_BOX = 200_000;
export const MAX_PRIZE_TYPES_PER_BOX = 1_000;
export const MAX_TICKETS_PER_DRAW_REQUEST = 100;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertValidId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw kujiError('INVALID_INPUT', `${field} must be a non-empty id (letters, digits, "_.:-", max 128 chars).`, { field, value });
  }
  return value;
}

export function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw kujiError('INVALID_INPUT', `${field} must be a positive integer.`, { field, value });
  }
  return value;
}

/**
 * Validates a CreateBoxInput. Rejects unknown top-level fields so a host
 * accidentally (or deliberately) passing extra fields like `seed`, `rng`,
 * `weights`, or `forcedPrizeId` fails loudly instead of being silently
 * ignored — see README "Fairness": the engine intentionally exposes no such
 * parameters anywhere in its public API.
 */
export function validateCreateBoxInput(input: CreateBoxInput): {
  id: string;
  prizes: PrizeInput[];
  lastOnePrizeId: string | null;
  saleOpensAt: string | null;
  finalQueueThreshold: number | null;
} {
  if (!isPlainObject(input)) {
    throw kujiError('INVALID_INPUT', 'createBox input must be an object.');
  }
  const knownKeys = new Set(['id', 'prizes', 'lastOnePrizeId', 'saleOpensAt', 'finalQueueThreshold']);
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) {
      throw kujiError('INVALID_INPUT', `Unknown field "${key}" in createBox input.`, { field: key });
    }
  }

  const id = assertValidId(input.id, 'id');

  if (!Array.isArray(input.prizes) || input.prizes.length === 0) {
    throw kujiError('INVALID_INPUT', 'prizes must be a non-empty array.');
  }
  if (input.prizes.length > MAX_PRIZE_TYPES_PER_BOX) {
    throw kujiError('INVALID_INPUT', `prizes exceeds the maximum of ${MAX_PRIZE_TYPES_PER_BOX} distinct prize types.`);
  }

  const seenPrizeIds = new Set<string>();
  const prizes: PrizeInput[] = [];
  let total = 0;
  for (const [index, raw] of input.prizes.entries()) {
    if (!isPlainObject(raw)) {
      throw kujiError('INVALID_INPUT', `prizes[${index}] must be an object.`);
    }
    const prizeKnownKeys = new Set(['id', 'quantity']);
    for (const key of Object.keys(raw)) {
      if (!prizeKnownKeys.has(key)) {
        throw kujiError('INVALID_INPUT', `Unknown field "${key}" in prizes[${index}].`);
      }
    }
    const prizeId = assertValidId(raw.id, `prizes[${index}].id`);
    if (seenPrizeIds.has(prizeId)) {
      throw kujiError('INVALID_INPUT', `Duplicate prize id "${prizeId}" in prizes.`, { prizeId });
    }
    seenPrizeIds.add(prizeId);
    const quantity = assertPositiveInteger(raw.quantity, `prizes[${index}].quantity`);
    total += quantity;
    prizes.push({ id: prizeId, quantity });
  }

  if (total > MAX_TICKETS_PER_BOX) {
    throw kujiError('INVALID_INPUT', `Total ticket count ${total} exceeds the maximum of ${MAX_TICKETS_PER_BOX}.`, { total });
  }

  let lastOnePrizeId: string | null = null;
  if (input.lastOnePrizeId !== undefined) {
    lastOnePrizeId = assertValidId(input.lastOnePrizeId, 'lastOnePrizeId');
    if (!seenPrizeIds.has(lastOnePrizeId)) {
      throw kujiError('INVALID_INPUT', `lastOnePrizeId "${lastOnePrizeId}" is not one of the prizes in this box.`, { lastOnePrizeId });
    }
  }

  let saleOpensAt: string | null = null;
  if (input.saleOpensAt !== undefined) {
    const d = input.saleOpensAt instanceof Date ? input.saleOpensAt : new Date(input.saleOpensAt);
    if (Number.isNaN(d.getTime())) {
      throw kujiError('INVALID_INPUT', 'saleOpensAt must be a valid Date or ISO-8601 string.');
    }
    saleOpensAt = d.toISOString();
  }

  let finalQueueThreshold: number | null = null;
  if (input.finalQueueThreshold !== undefined) {
    if (typeof input.finalQueueThreshold !== 'number' || !Number.isInteger(input.finalQueueThreshold) || input.finalQueueThreshold < 0) {
      throw kujiError('INVALID_INPUT', 'finalQueueThreshold must be a non-negative integer.');
    }
    if (input.finalQueueThreshold > total) {
      throw kujiError('INVALID_INPUT', 'finalQueueThreshold cannot exceed the total ticket count.');
    }
    finalQueueThreshold = input.finalQueueThreshold;
  }

  return { id, prizes, lastOnePrizeId, saleOpensAt, finalQueueThreshold };
}

/**
 * Recommended default for finalQueueThreshold when the host doesn't supply
 * one: min(10, ceil(total/6)). Mirrors the production heuristic this engine
 * is modeled on — large boxes get a fixed 10-ticket queue tail, small/test
 * boxes get a proportionally smaller one. Hosts remain free to override it.
 */
export function recommendedFinalQueueThreshold(totalTickets: number): number {
  if (!Number.isInteger(totalTickets) || totalTickets < 0) {
    throw kujiError('INVALID_INPUT', 'totalTickets must be a non-negative integer.');
  }
  return Math.min(10, Math.ceil(totalTickets / 6));
}

export function validateDrawInput(input: DrawInput): { requestId: string; holder: string; ticketNos: number[] } {
  if (!isPlainObject(input)) {
    throw kujiError('INVALID_INPUT', 'draw input must be an object.');
  }
  const knownKeys = new Set(['requestId', 'holder', 'ticketNos']);
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) {
      throw kujiError('INVALID_INPUT', `Unknown field "${key}" in draw input.`, { field: key });
    }
  }
  const requestId = assertValidId(input.requestId, 'requestId');
  const holder = assertValidId(input.holder, 'holder');

  if (!Array.isArray(input.ticketNos) || input.ticketNos.length === 0) {
    throw kujiError('INVALID_INPUT', 'ticketNos must be a non-empty array.');
  }
  if (input.ticketNos.length > MAX_TICKETS_PER_DRAW_REQUEST) {
    throw kujiError('INVALID_INPUT', `ticketNos exceeds the maximum of ${MAX_TICKETS_PER_DRAW_REQUEST} per request.`);
  }
  const seen = new Set<number>();
  for (const [index, raw] of input.ticketNos.entries()) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      throw kujiError('INVALID_INPUT', `ticketNos[${index}] must be a positive integer.`);
    }
    if (seen.has(raw)) {
      throw kujiError('INVALID_INPUT', `Duplicate ticket number ${raw} in ticketNos.`, { ticketNo: raw });
    }
    seen.add(raw);
  }
  // Sort so that requests differing only in ticketNos order hash identically (see recovery/idempotency.ts).
  const ticketNos = [...seen].sort((a, b) => a - b);
  return { requestId, holder, ticketNos };
}
