import { createHash } from 'node:crypto';

/**
 * Canonical hash of a request's meaningful payload, used to distinguish a
 * genuine retry (same requestId, same payload -> replay cached result) from
 * an id collision (same requestId, different payload -> REQUEST_CONFLICT).
 * Not a security boundary — just a cheap equality fingerprint.
 */
export function computePayloadHash(payload: unknown): string {
  const json = JSON.stringify(payload, Object.keys(payload as object).sort());
  return createHash('sha256').update(json).digest('hex');
}
