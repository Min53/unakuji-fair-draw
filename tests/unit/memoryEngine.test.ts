import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryKujiEngine } from '../../src/adapters/memory';
import { isKujiError } from '../../src/errors';

async function assertCode(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    assert.fail('expected a KujiError');
  } catch (err) {
    assert.ok(isKujiError(err));
    assert.equal(err.code, code);
  }
}

test('MemoryKujiEngine: full box lifecycle (create -> open -> draw) and duplicate-id rejection', async () => {
  const engine = new MemoryKujiEngine();
  await engine.createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 2 }] });
  await assertCode(() => engine.createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 1 }] }), 'BOX_ALREADY_EXISTS');

  await assertCode(() => engine.draw('b1', { requestId: 'r1', holder: 'h1', ticketNos: [1] }), 'BOX_NOT_ON_SALE');
  await engine.openBox('b1');
  const result = await engine.draw('b1', { requestId: 'r1', holder: 'h1', ticketNos: [1] });
  assert.equal(result.items.length, 1);
});

test('MemoryKujiEngine: reservation blocks other holders until it expires, then a draw succeeds', async () => {
  const engine = new MemoryKujiEngine();
  await engine.createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 1 }] });
  await engine.openBox('b1');

  await engine.reserveTickets('b1', { requestId: 'resv1', holder: 'alice', ticketNos: [1], ttlMs: 10 });
  await assertCode(() => engine.draw('b1', { requestId: 'r1', holder: 'bob', ticketNos: [1] }), 'TICKET_UNAVAILABLE');

  await new Promise((resolve) => setTimeout(resolve, 20));
  await engine.expireReservations('b1');
  const result = await engine.draw('b1', { requestId: 'r2', holder: 'bob', ticketNos: [1] });
  assert.equal(result.items[0]!.ticketNo, 1);
});

test('MemoryKujiEngine: many truly concurrent draws for the same single ticket resolve to exactly one winner', async () => {
  const engine = new MemoryKujiEngine();
  await engine.createBox({ id: 'b1', prizes: [{ id: 'A', quantity: 1 }] });
  await engine.openBox('b1');

  const attempts = Array.from({ length: 20 }, (_, i) =>
    engine.draw('b1', { requestId: `r${i}`, holder: `holder-${i}`, ticketNos: [1] }).then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, code: isKujiError(err) ? err.code : 'UNKNOWN' })
    )
  );
  const settled = await Promise.all(attempts);
  const wins = settled.filter((s) => s.ok);
  assert.equal(wins.length, 1, 'exactly one of the concurrent attempts should win the single ticket');
  assert.ok(settled.filter((s) => !s.ok).every((s) => !s.ok && (s.code === 'TICKET_UNAVAILABLE' || s.code === 'BOX_NOT_ON_SALE')));
});
