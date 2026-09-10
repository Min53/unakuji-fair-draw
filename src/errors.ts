/**
 * All engine failures use one error type with a stable machine-readable code.
 * Validation failures never mutate state; callers should switch on `code`,
 * not parse `message` (message is for humans/logs only).
 */
export const ERROR_CODES = [
  'INVALID_INPUT',
  'BOX_NOT_FOUND',
  'BOX_ALREADY_EXISTS',
  'BOX_NOT_ON_SALE',
  'SOLD_OUT',
  'TICKET_NOT_FOUND',
  'TICKET_UNAVAILABLE',
  'RESERVATION_CONFLICT',
  'RESERVATION_EXPIRED',
  'RESERVATION_NOT_FOUND',
  'FORBIDDEN',
  'ENTITLEMENT_NOT_FOUND',
  'ENTITLEMENT_INVALID',
  'ENTITLEMENT_ALREADY_CONSUMED',
  'ENTITLEMENT_LIMIT_EXCEEDED',
  'ENTITLEMENT_TICKET_MISMATCH',
  'QUEUE_NOT_REQUIRED',
  'QUEUE_ALREADY_JOINED',
  'QUEUE_TURN_REQUIRED',
  'QUEUE_ENTRY_NOT_FOUND',
  'REQUEST_CONFLICT',
  'RNG_FAILURE',
  'INVALID_STATE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_SET.has(value);
}

export interface KujiErrorDetails {
  readonly [key: string]: unknown;
}

export class KujiError extends Error {
  readonly code: ErrorCode;
  readonly details: KujiErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, details?: KujiErrorDetails) {
    super(message);
    this.name = 'KujiError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, KujiError.prototype);
  }
}

export function isKujiError(err: unknown): err is KujiError {
  return err instanceof KujiError;
}

export function kujiError(code: ErrorCode, message: string, details?: KujiErrorDetails): KujiError {
  return new KujiError(code, message, details);
}
