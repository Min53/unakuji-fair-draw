import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import { PostgresKujiEngine } from '../../src/adapters/postgres';

/**
 * Proves the grants in db/005_roles.sql are narrow enough to be worth having.
 *
 * The rest of the suite proves the role can still do its job; this file proves
 * it cannot do the one thing the engine's fairness claim depends on ruling out:
 * rewriting a draw result, or the commitment that attests to it, by talking to
 * the tables directly instead of going through the kuji_* functions.
 *
 * Run it against a connection that uses the unakuji_app role (CI does). When it
 * runs as a superuser the grants do not apply at all, so the checks are skipped
 * rather than passing vacuously.
 */
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:devpass@localhost:55432/unakuji' });
const engine = new PostgresKujiEngine(pool);

after(async () => {
  await pool.end();
});

async function isSuperuser(): Promise<boolean> {
  const { rows } = await pool.query<{ super: boolean }>(
    'SELECT rolsuper AS super FROM pg_roles WHERE rolname = current_user',
  );
  return rows[0]?.super === true;
}

async function assertRefused(sql: string, params: unknown[], what: string) {
  try {
    await pool.query(sql, params);
    assert.fail(`${what} was allowed — db/005_roles.sql grants more than it should`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    assert.equal(code, '42501', `${what} failed with ${code ?? String(err)}, expected insufficient_privilege`);
  }
}

test('the application role cannot rewrite a draw result or its commitment', async (t) => {
  if (await isSuperuser()) {
    t.skip('connected as a superuser — column grants do not apply; point DATABASE_URL at unakuji_app');
    return;
  }

  const id = `test-roles-${randomUUID()}`;
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 2 }, { id: 'B', quantity: 1 }], finalQueueThreshold: 0 });
  await engine.openBox(id);

  // The whole point: a prize assignment is written once and never updatable.
  await assertRefused(
    `UPDATE tickets SET prize_id = 'A' WHERE box_id = $1 AND ticket_no = 1`,
    [id],
    'UPDATE tickets.prize_id',
  );
  // ...nor can a row be moved to a different ticket number to the same effect.
  await assertRefused(
    `UPDATE tickets SET ticket_no = 99 WHERE box_id = $1 AND ticket_no = 1`,
    [id],
    'UPDATE tickets.ticket_no',
  );
  // ...nor can the fingerprint be rewritten to match a tampered assignment.
  await assertRefused(
    `UPDATE boxes SET assignment_commitment = 'forged' WHERE id = $1`,
    [id],
    'UPDATE boxes.assignment_commitment',
  );
  await assertRefused(
    `UPDATE boxes SET assignment_salt = 'forged' WHERE id = $1`,
    [id],
    'UPDATE boxes.assignment_salt',
  );
  // History is append-only for this role, so a tampered draw cannot be tidied up.
  await assertRefused(`DELETE FROM tickets WHERE box_id = $1`, [id], 'DELETE FROM tickets');
  await assertRefused(`DELETE FROM audit_log WHERE box_id = $1`, [id], 'DELETE FROM audit_log');

  // And the normal path still works after all of that.
  const result = await engine.draw(id, { requestId: 'roles-r1', holder: 'roles-h1', ticketNos: [1] });
  assert.equal(result.items.length, 1);
  const report = await engine.reconcile(id);
  assert.equal(report.commitmentOk, true);
});
