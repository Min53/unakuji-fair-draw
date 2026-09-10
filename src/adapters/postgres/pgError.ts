import { isErrorCode, kujiError } from '../../errors';

/**
 * Every RAISE EXCEPTION in db/*.sql starts its message with "CODE: text"
 * (see db/002_functions.sql file header). This turns that convention back
 * into a KujiError. Errors that don't match the convention (a real bug, a
 * connection failure, a constraint violation from outside this engine's own
 * functions) are rethrown unchanged — they are not silently reclassified as
 * domain errors.
 */
export function translatePgError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const separatorIndex = message.indexOf(': ');
  if (separatorIndex > 0) {
    const code = message.slice(0, separatorIndex);
    if (isErrorCode(code)) {
      throw kujiError(code, message.slice(separatorIndex + 2), {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw err;
}
