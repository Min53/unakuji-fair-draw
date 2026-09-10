import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBox } from '../../src/core/createBox';
import { draw } from '../../src/core/draw';
import { getPublicBox } from '../../src/core/getPublicBox';
import { computeAssignmentCommitment, verifyAssignmentCommitment } from '../../src/core/integrity';
import { isKujiError } from '../../src/errors';
import { assignTickets } from '../../src/rng';
import { validateCreateBoxInput } from '../../src/validation';

function assertCode(fn: () => unknown, code: string) {
  try {
    fn();
    assert.fail('expected a KujiError');
  } catch (err) {
    assert.ok(isKujiError(err));
    assert.equal(err.code, code);
  }
}

function openBox(state: ReturnType<typeof createBox>['state']) {
  return { ...state, status: 'on_sale' as const };
}

// -- Fair, quantity-preserving assignment -----------------------------------

test('assignment preserves exact prize quantities and numbers tickets 1..N', () => {
  const prizes = [{ id: 'A', quantity: 3 }, { id: 'B', quantity: 5 }, { id: 'C', quantity: 1 }];
  const assignment = assignTickets(prizes);
  const counts = new Map<string, number>();
  for (const t of assignment) counts.set(t.prizeId, (counts.get(t.prizeId) ?? 0) + 1);
  assert.equal(counts.get('A'), 3);
  assert.equal(counts.get('B'), 5);
  assert.equal(counts.get('C'), 1);
  assert.deepEqual(assignment.map((t) => t.ticketNo).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('the public API has no seed/rng-injection/weights/forced-prize parameter (fairness invariant)', () => {
  assert.equal(assignTickets.length, 1); // takes only `prizes`
  for (const extra of [{ seed: 42 }, { rng: () => 0 }, { weights: { A: 0.9 } }, { forcedPrizeId: 'A' }]) {
    assertCode(() => validateCreateBoxInput({ id: 'box-1', prizes: [{ id: 'A', quantity: 1 }], ...extra } as never), 'INVALID_INPUT');
  }
});

test('createBox input validation rejects malformed configurations (duplicate/invalid prizes, bad lastOnePrizeId)', () => {
  assertCode(() => validateCreateBoxInput({ id: 'b', prizes: [{ id: 'A', quantity: 1 }, { id: 'A', quantity: 1 }] }), 'INVALID_INPUT');
  assertCode(() => validateCreateBoxInput({ id: 'b', prizes: [{ id: 'A', quantity: 0 }] }), 'INVALID_INPUT');
  assertCode(() => validateCreateBoxInput({ id: 'b', prizes: [] }), 'INVALID_INPUT');
  assertCode(() => validateCreateBoxInput({ id: 'b', prizes: [{ id: 'A', quantity: 1 }], lastOnePrizeId: 'B' }), 'INVALID_INPUT');
});

// -- Assignment integrity (tamper-evidence, not a Merkle proof) -------------

test('assignment commitment verifies the real assignment and catches tampering', () => {
  const { state, assignmentSalt } = createBox({ id: 'box-1', prizes: [{ id: 'A', quantity: 2 }, { id: 'B', quantity: 1 }] });
  const assignment = state.tickets.map((t) => ({ ticketNo: t.ticketNo, prizeId: t.prizeId }));
  assert.equal(computeAssignmentCommitment('box-1', assignment, assignmentSalt), state.assignmentCommitment);
  assert.ok(verifyAssignmentCommitment('box-1', assignment, assignmentSalt, state.assignmentCommitment));

  // Append a suffix rather than hardcoding a specific prize id, so this
  // assertion is deterministic regardless of what the random assignment
  // actually gave ticket 1 (it can never already equal "<x>-tampered").
  const tampered = assignment.map((t) => (t.ticketNo === 1 ? { ...t, prizeId: `${t.prizeId}-tampered` } : t));
  assert.equal(verifyAssignmentCommitment('box-1', tampered, assignmentSalt, state.assignmentCommitment), false);
});

// -- Draw: consumption, reuse rejection, atomicity, idempotency, last-one --

test('draw consumes the requested ticket(s) and rejects a box that is not on_sale', () => {
  const { state } = createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 1 }] });
  assertCode(() => draw(state, { requestId: 'r1', holder: 'h1', ticketNos: [1] }), 'BOX_NOT_ON_SALE');
  const { nextState, result } = draw(openBox(state), { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  assert.equal(result.items[0]!.ticketNo, 1);
  assert.equal(nextState.tickets.find((t) => t.ticketNo === 1)!.status, 'consumed');
});

test('an already-consumed ticket is rejected on reuse (no double-payout)', () => {
  // Two tickets so the box stays on_sale after the first draw, isolating the
  // ticket-level check from the box-status check.
  const { state } = createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 2 }] });
  const { nextState } = draw(openBox(state), { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  assertCode(() => draw(nextState, { requestId: 'r2', holder: 'h2', ticketNos: [1] }), 'TICKET_UNAVAILABLE');
});

test('multi-ticket draw is all-or-nothing: one unavailable ticket fails the whole request and leaves the rest untouched', () => {
  const { state } = createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 3 }] });
  const { nextState: afterFirst } = draw(openBox(state), { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  assertCode(() => draw(afterFirst, { requestId: 'r2', holder: 'h2', ticketNos: [1, 2] }), 'TICKET_UNAVAILABLE');
  assert.equal(afterFirst.tickets.find((t) => t.ticketNo === 2)!.status, 'available'); // untouched, not partially consumed
});

test('idempotency: same requestId+input replays the cached result; same requestId with different input conflicts', () => {
  const { state } = createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 2 }] });
  const onSale = openBox(state);
  const first = draw(onSale, { requestId: 'r1', holder: 'h1', ticketNos: [1, 2] });
  const replay = draw(first.nextState, { requestId: 'r1', holder: 'h1', ticketNos: [2, 1] }); // order-independent
  assert.deepEqual(replay.result, first.result);
  assertCode(() => draw(first.nextState, { requestId: 'r1', holder: 'h1', ticketNos: [1] }), 'REQUEST_CONFLICT');
});

test('draw never mutates the state object it was given', () => {
  const onSale = openBox(createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 1 }] }).state);
  const before = JSON.stringify(onSale);
  draw(onSale, { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  assert.equal(JSON.stringify(onSale), before);
});

test('last-one is awarded exactly once, only to the request that empties the box', () => {
  const { state } = createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 2 }], lastOnePrizeId: 'A' });
  const onSale = openBox(state);
  const first = draw(onSale, { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  assert.equal(first.result.lastOneAwarded, false);
  const second = draw(first.nextState, { requestId: 'r2', holder: 'h2', ticketNos: [2] });
  assert.equal(second.result.lastOneAwarded, true);
  assert.equal(second.result.lastOnePrizeId, 'A');
  assert.equal(second.nextState.status, 'sold_out');
});

// -- Public view: never exposes unsold assignment ---------------------------

test('getPublicBox exposes remaining counts but never which prize an undrawn ticket holds', () => {
  const { state } = createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 2 }, { id: 'B', quantity: 1 }] });
  const view = getPublicBox(state);
  assert.ok(!('tickets' in view));
  assert.ok(!('completedRequests' in view));
  assert.equal(view.remaining, 3);

  const { nextState } = draw(openBox(state), { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  const afterDraw = getPublicBox(nextState);
  assert.equal(afterDraw.remaining, 2);
});
