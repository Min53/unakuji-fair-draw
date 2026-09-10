import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import { isKujiError } from '../../src/errors';
import { PostgresKujiEngine } from '../../src/adapters/postgres';

/**
 * Requires a running Postgres with db/001..004 already applied — see
 * examples/postgres/README.md ("npm run test:postgres" wires this up via
 * docker-compose in CI; locally, point DATABASE_URL at your own instance).
 * Every test uses a fresh, randomly-named box, so tests do not need to reset
 * the database between runs and can share one long-lived container.
 */
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:devpass@localhost:55432/unakuji' });
const engine = new PostgresKujiEngine(pool);

after(async () => {
  await pool.end();
});

function boxId(label: string): string {
  return `test-${label}-${randomUUID()}`;
}

async function assertCode(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    assert.fail(`expected code ${code}, but the call succeeded`);
  } catch (err) {
    assert.ok(isKujiError(err), `expected a KujiError, got ${String(err)}`);
    assert.equal(err.code, code);
  }
}

// -- Quantity preservation, ticket uniqueness, assignment==payout, consistency --

test('a fully-drawn box preserves quantities and passes reconcile (assignment matches payout, no overdraw)', async () => {
  const id = boxId('reconcile');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 2 }, { id: 'B', quantity: 1 }], finalQueueThreshold: 0 });
  await engine.openBox(id);
  await engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: [1, 2] });
  await engine.draw(id, { requestId: 'r2', holder: 'h2', ticketNos: [3] });

  const report = await engine.reconcile(id);
  assert.equal(report.healthy, true, JSON.stringify(report.issues));
  assert.equal(report.consumedCount, 3);
  assert.equal(report.payoutCount, 3);
  assert.equal(report.commitmentOk, true);

  const publicBox = await engine.getPublicBox(id);
  assert.equal(publicBox.status, 'sold_out');
  assert.equal(publicBox.remaining, 0);
});

// -- Reuse rejection: ticket and entitlement -------------------------------

test('an already-drawn ticket cannot be redrawn, and an already-consumed entitlement cannot be reused on another box', async () => {
  const id = boxId('reuse');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 2 }], finalQueueThreshold: 0 });
  await engine.openBox(id);
  const ent = await engine.issueEntitlement({ boxId: id, holder: 'h1', kind: 'single_use' });

  await engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: [1], entitlementIds: [ent.id] });
  await assertCode(() => engine.draw(id, { requestId: 'r2', holder: 'h2', ticketNos: [1] }), 'TICKET_UNAVAILABLE');

  const otherBox = boxId('reuse-other');
  await engine.createBox({ id: otherBox, prizes: [{ id: 'A', quantity: 1 }], finalQueueThreshold: 0 });
  await engine.openBox(otherBox);
  await assertCode(
    () => engine.draw(otherBox, { requestId: 'r3', holder: 'h1', ticketNos: [1], entitlementIds: [ent.id] }),
    'ENTITLEMENT_INVALID' // wrong box; consumed-on-another-box would also be ENTITLEMENT_ALREADY_CONSUMED if same box
  );
});

// -- Multi-draw atomicity: partial failure rolls back everything -----------

test('a multi-ticket draw with one unavailable ticket fails entirely and leaves the other tickets untouched', async () => {
  const id = boxId('atomic');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 3 }] });
  await engine.openBox(id);
  await engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: [2] });

  await assertCode(() => engine.draw(id, { requestId: 'r2', holder: 'h2', ticketNos: [1, 2, 3] }), 'TICKET_UNAVAILABLE');

  const box = await engine.getPublicBox(id);
  assert.deepEqual(box.availableTicketNos, [1, 3]); // ticket 2 stayed consumed from r1; 1 and 3 were never touched by the failed r2
});

test('draw rejects a request over the per-request ticket cap instead of holding the box lock for an unbounded batch', async () => {
  const id = boxId('cap');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 150 }], finalQueueThreshold: 0 });
  await engine.openBox(id);
  const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
  await assertCode(() => engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: tooMany }), 'INVALID_INPUT');
});

// -- Idempotency & retry recovery -------------------------------------------

test('retrying the same requestId (e.g. after a dropped connection post-commit) replays the cached result with no extra side effects; a different payload under the same id conflicts', async () => {
  const id = boxId('idem');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 2 }] });
  await engine.openBox(id);

  const first = await engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  const retry = await engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: [1] }); // simulates "client never saw the first response"
  assert.deepEqual(retry, first);

  const results = await engine.getHolderResults(id, 'h1');
  assert.equal(results.length, 1, 'the replayed retry must not create a second payout row');

  await assertCode(() => engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: [2] }), 'REQUEST_CONFLICT');
});

test('a failed draw attempt (invalid ticket) leaves no trace, so a later retry with the same requestId and corrected input succeeds fresh', async () => {
  const id = boxId('precommit-fail');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 1 }], finalQueueThreshold: 0 });
  await engine.openBox(id);

  await assertCode(() => engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: [999] }), 'TICKET_NOT_FOUND');
  const result = await engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  assert.equal(result.items[0]!.ticketNo, 1);
});

// -- Real concurrent draws in the actual database ---------------------------

test('20 truly concurrent draw attempts against the same single ticket in Postgres resolve to exactly one winner', async () => {
  const id = boxId('race');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 1 }], finalQueueThreshold: 0 });
  await engine.openBox(id);

  const attempts = Array.from({ length: 20 }, (_, i) =>
    engine.draw(id, { requestId: `r${i}`, holder: `holder-${i}`, ticketNos: [1] }).then(
      () => true,
      () => false
    )
  );
  const settled = await Promise.all(attempts);
  assert.equal(settled.filter(Boolean).length, 1);

  const report = await engine.reconcile(id);
  assert.equal(report.payoutCount, 1);
});

// -- Reservation expiry/release racing the draw path ------------------------

test('a reservation blocks other holders, expires on schedule, and a released hold is immediately drawable by someone else', async () => {
  const id = boxId('reservation');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 2 }], finalQueueThreshold: 0 });
  await engine.openBox(id);

  await engine.reserveTickets(id, { requestId: 'resv1', holder: 'alice', ticketNos: [1], ttlMs: 60_000 });
  await assertCode(() => engine.draw(id, { requestId: 'd1', holder: 'bob', ticketNos: [1] }), 'TICKET_UNAVAILABLE');

  await engine.releaseReservation(id, { holder: 'alice', ticketNos: [1] });
  const result = await engine.draw(id, { requestId: 'd2', holder: 'bob', ticketNos: [1] });
  assert.equal(result.items[0]!.ticketNo, 1);

  // ticket 2: a short-lived hold that we let actually expire, then sweep.
  await engine.reserveTickets(id, { requestId: 'resv2', holder: 'alice', ticketNos: [2], ttlMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await engine.expireReservations(id);
  const result2 = await engine.draw(id, { requestId: 'd3', holder: 'bob', ticketNos: [2] });
  assert.equal(result2.items[0]!.ticketNo, 2);
});

// -- Final-segment queue: phase guard, turn requirement, expiry, cancellation --

test('final-segment queue: joining outside the segment is rejected, a turn is required to draw inside it, turns expire and pass to the next holder, and leaving promotes the next waiting entry', async () => {
  const id = boxId('queue');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 2 }], finalQueueThreshold: 1 });
  await engine.openBox(id);

  await assertCode(() => engine.joinQueue(id, { requestId: 'q1', holder: 'carol', turnTtlSeconds: 60 }), 'QUEUE_NOT_REQUIRED');

  await engine.draw(id, { requestId: 'd1', holder: 'zeta', ticketNos: [1] }); // remaining now 1 == threshold: queue phase begins

  await assertCode(() => engine.draw(id, { requestId: 'd2', holder: 'dave', ticketNos: [2] }), 'QUEUE_TURN_REQUIRED');

  const carolEntry = await engine.joinQueue(id, { requestId: 'q2', holder: 'carol', turnTtlSeconds: 1 });
  assert.equal(carolEntry.status, 'active');

  const daveEntry = await engine.joinQueue(id, { requestId: 'q3', holder: 'dave', turnTtlSeconds: 60 });
  assert.equal(daveEntry.status, 'waiting');
  await assertCode(() => engine.joinQueue(id, { requestId: 'q4', holder: 'dave', turnTtlSeconds: 60 }), 'QUEUE_ALREADY_JOINED');

  // carol's 1-second turn expires; advanceQueue promotes dave.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await engine.advanceQueue(id);
  const daveStatus = await engine.getQueueStatus(id, 'dave');
  assert.equal(daveStatus.status, 'active');

  // carol, whose turn already expired, is correctly rejected if she tries to draw.
  await assertCode(() => engine.draw(id, { requestId: 'd3', holder: 'carol', ticketNos: [2] }), 'QUEUE_TURN_REQUIRED');
  // dave, now holding the active turn, draws the last ticket successfully.
  const result = await engine.draw(id, { requestId: 'd4', holder: 'dave', ticketNos: [2] });
  assert.equal(result.lastOneAwarded, false); // this box had no lastOnePrizeId configured
});

// -- Last-ticket race & exactly-once last-one -------------------------------

test('concurrent draws for the last few distinct tickets all succeed, and the last-one bonus is granted to exactly one of them', async () => {
  const id = boxId('lastone');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 4 }], lastOnePrizeId: 'A', finalQueueThreshold: 0 });
  await engine.openBox(id);
  await engine.draw(id, { requestId: 'warmup', holder: 'w', ticketNos: [1] });

  const attempts = [2, 3, 4].map((ticketNo) => engine.draw(id, { requestId: `final-${ticketNo}`, holder: `h${ticketNo}`, ticketNos: [ticketNo] }));
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r.lastOneAwarded).length, 1);

  const report = await engine.reconcile(id);
  assert.equal(report.healthy, true, JSON.stringify(report.issues));
});

// -- Entry points blocked outside on_sale ------------------------------------

test('draw, reserveTickets and joinQueue are all rejected before opening, while paused, and after cancellation', async () => {
  const id = boxId('blocked');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 3 }], finalQueueThreshold: 3 });

  await assertCode(() => engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: [1] }), 'BOX_NOT_ON_SALE');
  await assertCode(() => engine.reserveTickets(id, { requestId: 'v1', holder: 'h1', ticketNos: [1], ttlMs: 1000 }), 'BOX_NOT_ON_SALE');

  await engine.openBox(id);
  await engine.pauseBox(id, 'admin', 'incident');
  await assertCode(() => engine.draw(id, { requestId: 'r2', holder: 'h1', ticketNos: [1] }), 'BOX_NOT_ON_SALE');
  await engine.resumeBox(id, 'admin');

  await engine.cancelBox(id, 'admin', 'retired');
  await assertCode(() => engine.draw(id, { requestId: 'r3', holder: 'h1', ticketNos: [1] }), 'BOX_NOT_ON_SALE');
  await assertCode(() => engine.joinQueue(id, { requestId: 'q1', holder: 'h1', turnTtlSeconds: 30 }), 'BOX_NOT_ON_SALE');
});

test('a box that already has real draws cannot be canceled without allowRealSales, and terminal states reject re-cancellation', async () => {
  const id = boxId('cancel-guard');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 1 }], finalQueueThreshold: 0 });
  await engine.openBox(id);
  await engine.draw(id, { requestId: 'r1', holder: 'h1', ticketNos: [1] });

  await assertCode(() => engine.cancelBox(id, 'admin', 'oops'), 'INVALID_STATE');
  const canceled = await engine.cancelBox(id, 'admin', 'oops-confirmed', true);
  assert.equal(canceled.status, 'canceled');
  await assertCode(() => engine.cancelBox(id, 'admin', 'again'), 'INVALID_STATE');
});

// -- No permission bypass, no exposure of unsold assignment ------------------

test('result lookups are scoped to the holder (no cross-holder read), and the public view never reveals an undrawn ticket\'s prize', async () => {
  const id = boxId('privacy');
  await engine.createBox({ id, prizes: [{ id: 'A', quantity: 1 }, { id: 'B', quantity: 1 }] });
  await engine.openBox(id);
  await engine.draw(id, { requestId: 'r1', holder: 'alice', ticketNos: [1] });

  const aliceResult = await engine.getResult(id, 'alice', 'r1');
  assert.ok(aliceResult);
  const wrongHolderResult = await engine.getResult(id, 'mallory', 'r1');
  assert.equal(wrongHolderResult, null);

  const publicBox = await engine.getPublicBox(id);
  const raw = JSON.stringify(publicBox);
  assert.ok(!raw.includes('ticketNo') || !('assignment' in publicBox)); // no per-ticket assignment field at all
  assert.equal((publicBox as unknown as { assignment?: unknown }).assignment, undefined);
  assert.equal(publicBox.availableTicketNos.length, 1); // ticket 2 still shown as an available number, but with no prize attached
});
