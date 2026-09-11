import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import { PostgresKujiEngine } from '../../src/adapters/postgres';

/**
 * Proves the grants in db/005_roles.sql are narrow enough to be worth having.
 *
 * The rest of the suite proves the roles can still do their job; this file
 * proves they cannot do the things the engine's fairness claim depends on
 * ruling out — rewriting a result or its commitment by touching the tables
 * directly, and reaching the operator functions from the participant-facing
 * server. The kuji_* functions carry no authorization check of their own, so
 * EXECUTE is the authorization and it is worth a test.
 *
 * DATABASE_URL is a connection that holds both roles (CI grants both to a test
 * login) so boxes can be set up. APP_DATABASE_URL is unakuji_app alone; the
 * checks that need a restricted connection skip themselves when it is unset,
 * rather than passing vacuously.
 */
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:devpass@localhost:55432/unakuji' });
const appUrl = process.env.APP_DATABASE_URL;
const appPool = appUrl ? new Pool({ connectionString: appUrl }) : null;
const engine = new PostgresKujiEngine(pool);

after(async () => {
  await pool.end();
  await appPool?.end();
});

async function isSuperuser(p: Pool): Promise<boolean> {
  const { rows } = await p.query<{ super: boolean }>(
    'SELECT rolsuper AS super FROM pg_roles WHERE rolname = current_user',
  );
  return rows[0]?.super === true;
}

async function assertRefused(p: Pool, sql: string, params: unknown[], what: string) {
  try {
    await p.query(sql, params);
    assert.fail(`${what} was allowed — db/005_roles.sql grants more than it should`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    assert.equal(code, '42501', `${what} failed with ${code ?? String(err)}, expected insufficient_privilege`);
  }
}

async function freshBox(label: string): Promise<string> {
  const id = `test-roles-${label}-${randomUUID()}`;
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 2 }, { id: 'B', quantity: 1 }], finalQueueThreshold: 0 });
  await engine.openBox(id);
  return id;
}

test('neither role can rewrite a draw result or its commitment', async (t) => {
  if (await isSuperuser(pool)) {
    t.skip('connected as a superuser — column grants do not apply; point DATABASE_URL at the app/admin roles');
    return;
  }

  const id = await freshBox('columns');

  // The whole point: a prize assignment is written once and never updatable.
  await assertRefused(pool, `UPDATE tickets SET prize_id = 'A' WHERE box_id = $1 AND ticket_no = 1`, [id], 'UPDATE tickets.prize_id');
  // ...nor can a row be moved to a different ticket number to the same effect.
  await assertRefused(pool, `UPDATE tickets SET ticket_no = 99 WHERE box_id = $1 AND ticket_no = 1`, [id], 'UPDATE tickets.ticket_no');
  // ...nor can the fingerprint be rewritten to match a tampered assignment.
  await assertRefused(pool, `UPDATE boxes SET assignment_commitment = 'forged' WHERE id = $1`, [id], 'UPDATE boxes.assignment_commitment');
  await assertRefused(pool, `UPDATE boxes SET assignment_salt = 'forged' WHERE id = $1`, [id], 'UPDATE boxes.assignment_salt');
  // History is append-only, so a tampered draw cannot be tidied up afterwards.
  await assertRefused(pool, `DELETE FROM tickets WHERE box_id = $1`, [id], 'DELETE FROM tickets');
  await assertRefused(pool, `DELETE FROM audit_log WHERE box_id = $1`, [id], 'DELETE FROM audit_log');

  // And the normal path still works after all of that.
  const result = await engine.draw(id, { requestId: 'roles-r1', holder: 'roles-h1', ticketNos: [1] });
  assert.equal(result.items.length, 1);
  const report = await engine.reconcile(id);
  assert.equal(report.commitmentOk, true);
});

test('the participant-facing role cannot reach the operator functions', async (t) => {
  if (!appPool) {
    t.skip('APP_DATABASE_URL is unset — set it to a unakuji_app-only connection to run this');
    return;
  }
  if (await isSuperuser(appPool)) {
    t.skip('APP_DATABASE_URL connects as a superuser — EXECUTE grants do not apply');
    return;
  }

  const id = await freshBox('execute');

  // Postgres grants EXECUTE to PUBLIC by default; if 005_roles.sql ever stops
  // revoking that, every one of these becomes callable and this test fails.
  await assertRefused(appPool, `SELECT kuji_cancel_box($1, 'someone', 'because', true)`, [id], 'EXECUTE kuji_cancel_box');
  await assertRefused(appPool, `SELECT kuji_close_box($1, 'someone', 'because')`, [id], 'EXECUTE kuji_close_box');
  await assertRefused(appPool, `SELECT kuji_pause_box($1, 'someone', 'because')`, [id], 'EXECUTE kuji_pause_box');
  await assertRefused(appPool, `SELECT kuji_open_box($1, 'someone')`, [id], 'EXECUTE kuji_open_box');
  // Minting a new box means minting a new assignment to draw from.
  await assertRefused(
    appPool,
    `SELECT kuji_create_box($1, '[{"id":"A","quantity":1}]'::jsonb, '[{"ticketNo":1,"prizeId":"A"}]'::jsonb, 'x', 'y', NULL, NULL, 0)`,
    [`test-roles-forged-${randomUUID()}`],
    'EXECUTE kuji_create_box',
  );
  // Even with no function to call, it cannot insert the rows by hand.
  await assertRefused(appPool, `INSERT INTO boxes (id, total_tickets, assignment_commitment, assignment_salt) VALUES ($1, 1, 'x', 'y')`, [`test-roles-raw-${randomUUID()}`], 'INSERT INTO boxes');
  await assertRefused(appPool, `INSERT INTO tickets (box_id, ticket_no, prize_id) VALUES ($1, 999, 'A')`, [id], 'INSERT INTO tickets');

  // The participant path is unaffected.
  const { rows } = await appPool.query<{ ok: unknown }>(`SELECT kuji_public_box($1) AS ok`, [id]);
  assert.ok(rows[0]?.ok, 'kuji_public_box should still be callable by unakuji_app');
});
