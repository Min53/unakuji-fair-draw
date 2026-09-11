import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import { PostgresKujiEngine } from '../../src/adapters/postgres';

/**
 * The claim db/005_roles.sql makes: a caller can reach the tables only through
 * the kuji_* functions, and only the ones its role is meant to run.
 *
 * DATABASE_URL holds both roles (CI grants both to a test login) so a box can
 * be set up. APP_DATABASE_URL is unakuji_app alone; the checks that need a
 * restricted connection skip themselves when it is unset rather than passing
 * vacuously.
 */
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:devpass@localhost:55432/unakuji' });
const appUrl = process.env.APP_DATABASE_URL;
const appPool = appUrl ? new Pool({ connectionString: appUrl }) : null;
const engine = new PostgresKujiEngine(pool);

after(async () => {
  await pool.end();
  await appPool?.end();
});

async function assertRefused(p: Pool, sql: string, params: unknown[], what: string) {
  try {
    await p.query(sql, params);
    assert.fail(`${what} was allowed — db/005_roles.sql grants more than it should`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    assert.equal(code, '42501', `${what} failed with ${code ?? String(err)}, expected insufficient_privilege`);
  }
}

test('neither role can touch a table directly', async () => {
  // One question instead of a grant-by-grant inventory: does either role hold
  // any privilege on any table at all? The functions are SECURITY DEFINER, so
  // the answer has to be none — including SELECT, since tickets.prize_id for an
  // undrawn ticket is exactly what a participant must not be able to read.
  const { rows } = await pool.query<{ role: string; tables: number }>(
    `SELECT r.rolname AS role,
            count(*) FILTER (
              WHERE has_table_privilege(r.rolname, c.oid, 'SELECT')
                 OR has_table_privilege(r.rolname, c.oid, 'INSERT')
                 OR has_table_privilege(r.rolname, c.oid, 'UPDATE')
                 OR has_table_privilege(r.rolname, c.oid, 'DELETE')
            )::int AS tables
       FROM pg_catalog.pg_roles r
       CROSS JOIN pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rolname IN ('unakuji_app', 'unakuji_admin')
        AND n.nspname = 'public' AND c.relkind = 'r'
      GROUP BY r.rolname`,
  );

  assert.equal(rows.length, 2, 'both roles should exist — apply db/005_roles.sql');
  for (const row of rows) {
    assert.equal(row.tables, 0, `${row.role} holds table privileges on ${row.tables} table(s)`);
  }
});

test('the participant role can draw, and cannot produce a result any other way', async (t) => {
  if (!appPool) {
    t.skip('APP_DATABASE_URL is unset — set it to a unakuji_app-only connection to run this');
    return;
  }

  const id = `test-roles-${randomUUID()}`;
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 2 }, { id: 'B', quantity: 1 }], finalQueueThreshold: 0 });
  await engine.openBox(id);

  // kuji_get_result hands back purchase_requests.result verbatim, so writing
  // that row by hand would be a second way to produce a draw result.
  await assertRefused(
    appPool,
    `INSERT INTO purchase_requests (box_id, request_id, action, holder, payload_hash, result)
     VALUES ($1, 'forged', 'draw', 'someone', 'x', '{"items":[{"ticketNo":1,"prizeId":"A"}]}'::jsonb)`,
    [id],
    'INSERT INTO purchase_requests',
  );
  // Minting a box means minting an assignment to draw from.
  await assertRefused(
    appPool,
    `SELECT kuji_create_box($1, '[{"id":"A","quantity":1}]'::jsonb, '[{"ticketNo":1,"prizeId":"A"}]'::jsonb, 'x', 'y', NULL, NULL, 0)`,
    [`test-roles-forged-${randomUUID()}`],
    'EXECUTE kuji_create_box',
  );
  await assertRefused(appPool, `SELECT kuji_cancel_box($1, 'someone', 'because', true)`, [id], 'EXECUTE kuji_cancel_box');

  // ...and the participant path it is actually for still works end to end.
  const appEngine = new PostgresKujiEngine(appPool);
  const result = await appEngine.draw(id, { requestId: 'roles-r1', holder: 'roles-h1', ticketNos: [1] });
  assert.equal(result.items.length, 1);
  const report = await appEngine.reconcile(id);
  assert.equal(report.healthy, true, JSON.stringify(report.issues));
  assert.equal(report.commitmentOk, true);
});

test('createBox refuses an assignment that does not preserve the declared quantities', async () => {
  // The operator role can call kuji_create_box — that is what it is for — so the
  // check that the assignment is a permutation of the declared inventory has to
  // live in the function, not in the caller that happens to have shuffled.
  const id = `test-craft-${randomUUID()}`;
  const crafted = Array.from({ length: 3 }, (_, i) => ({ ticketNo: i + 1, prizeId: 'B' }));

  await assert.rejects(
    () =>
      pool.query(
        `SELECT kuji_create_box($1, '[{"id":"A","quantity":2},{"id":"B","quantity":1}]'::jsonb, $2::jsonb, 'x', 'y', NULL, NULL, 0)`,
        [id, JSON.stringify(crafted)],
      ),
    /does not preserve the declared prize quantities/,
  );
});
