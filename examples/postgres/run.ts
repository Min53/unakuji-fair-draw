/**
 * End-to-end example against a real PostgreSQL database. Requires the
 * schema to already be applied (see README.md in this folder). Run with:
 *   docker compose up -d
 *   DATABASE_URL=postgresql://postgres:devpass@localhost:55432/unakuji ./apply-schema.sh
 *   npx tsx examples/postgres/run.ts
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresKujiEngine } from '../../src/adapters/postgres';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:devpass@localhost:55432/unakuji' });
  const engine = new PostgresKujiEngine(pool);
  const boxId = `example-${randomUUID()}`;

  await engine.createBox({
    id: boxId,
    prizes: [
      { id: 'S-tier-figure', quantity: 1 },
      { id: 'A-tier-plush', quantity: 2 },
      { id: 'B-tier-keychain', quantity: 5 },
    ],
    lastOnePrizeId: 'A-tier-plush',
    finalQueueThreshold: 2, // the last 2 tickets require joining the queue first
  });
  await engine.openBox(boxId, 'example-admin');
  console.log('Box created and opened:', await engine.getPublicBox(boxId));

  // Optional: issue an entitlement (e.g. representing "this holder already
  // paid, via whatever purchase flow your own service uses") and pass its id
  // to draw(). Omit entitlementIds entirely if your integration polices
  // draw eligibility itself.
  const entitlement = await engine.issueEntitlement({ boxId, holder: 'user-42', kind: 'single_use', source: 'example' });

  const result = await engine.draw(boxId, {
    requestId: randomUUID(),
    holder: 'user-42',
    ticketNos: [1],
    entitlementIds: [entitlement.id],
  });
  console.log('Draw result:', result);

  const reconcileReport = await engine.reconcile(boxId);
  console.log('Consistency check:', reconcileReport);

  await engine.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
