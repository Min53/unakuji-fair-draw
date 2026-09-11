# unakuji-fair-draw

An operational **kuji-style draw engine**: quantity-preserving fair random
assignment, ticket reservations, entitlements ("draw passes"), a
final-segment queue, atomic draw + payout with idempotency and recovery, and
a production PostgreSQL reference implementation with real transactions,
locking, and consistency checks.

This is not a toy random-picker and not a cryptographic-proof platform. It's
a complete, independent, MIT-licensed implementation of the operational core
a real ticket-box draw service needs, meant to be dropped into your own
Node.js backend. Your service owns authentication, payment, shipping,
membership, and UI — this package owns "is this draw fair, atomic, and
correctly accounted for."

## Quick start

```bash
npm install unakuji-fair-draw
```

```ts
import { MemoryKujiEngine } from 'unakuji-fair-draw/memory';

const engine = new MemoryKujiEngine();

await engine.createBox({
  id: 'box-1',
  prizes: [
    { id: 'S-tier', quantity: 1 },
    { id: 'A-tier', quantity: 3 },
    { id: 'B-tier', quantity: 16 },
  ],
  lastOnePrizeId: 'A-tier', // awarded once, to whoever draws the final normal ticket
});
await engine.openBox('box-1');

const result = await engine.draw('box-1', {
  requestId: 'a-uuid-you-generate-per-attempt',
  holder: 'user-42', // an id YOUR system already authenticated
  ticketNos: [7],
});
```

`MemoryKujiEngine` is for local dev, tests, and prototyping. For anything
real, use the [PostgreSQL reference implementation](#postgresql-reference-implementation) —
see [Which adapter should I use?](#which-adapter-should-i-use).

Runnable versions of both: [`examples/basic.ts`](examples/basic.ts) (memory) and
[`examples/postgres/`](examples/postgres/) (Postgres, with docker-compose).

## What's included

| Area | What it does |
|---|---|
| Box lifecycle | `preparing → upcoming → on_sale → paused/sold_out/ended/canceled`, scheduled opening, guards against resetting a box that already has real draws |
| Fair assignment | Quantity-preserving Fisher–Yates shuffle using `crypto.randomInt`; ticket→prize mapping is fixed at creation and never changes |
| Reservations | Time-limited holds on specific ticket numbers, with ownership, expiry, and conflict handling |
| Entitlements | "Draw passes" with issuance limits, attribution, expiry, cancellation, and single-use-vs-unlimited semantics — the generalized form of purchase-linked codes, admin-granted comps, and reusable master passes |
| Final-segment queue | Turn-based access once remaining tickets drop to a configurable threshold, re-validated atomically at draw time |
| Draw & fulfillment | Atomic multi-ticket draw, payout ledger, remaining-quantity queries, per-holder result lookup |
| Last-one | Exactly-once bonus award to whoever draws the box's final normal ticket |
| Idempotency & recovery | Safe retries, request-id conflict detection, consistency (`reconcile`) checks |
| Permissions | Every read/write that touches a specific holder's data is scoped to a caller-supplied, host-authenticated holder id |
| Audit | Every admin state change (pause/cancel/close/entitlement cancel) is logged |

This table plus the API surface documented below is the contract — there is
no separate design doc shipped with the package.

## What this engine deliberately does not do

- **No result intervention of any kind.** There is no API, table, or code
  path anywhere in this package that can change which prize a ticket pays
  out after box creation, target a specific user/tier/ticket-position for a
  particular outcome, or swap an already-assigned prize. The invariant
  "the prize assigned to a ticket at creation is the prize it pays out" is
  enforced structurally: the `tickets` table has no admin-writable prize
  column, and no function ever updates one.
- **No seed, RNG-injection, weighting, or "forced prize" parameter.**
  `createBox` and every draw-adjacent function reject unknown input fields
  outright (see `src/validation.ts`).
- **No re-drawing a completed result.** Canceling an entitlement or a
  reservation only ever works on something *unused*; a consumed entitlement
  or a paid-out ticket cannot be reopened through this package's API.
- **No large cryptographic proof platform.** Fairness is provided by using a
  CSPRNG correctly and by structurally removing every intervention path —
  not by a Merkle tree, a public commit/reveal ceremony, or a verifier CLI.
  There is one lightweight tamper-evidence check (`verifyAssignmentCommitment` /
  `kuji_reconcile`), not a proof system.
- **No payment, shipping, membership, or points.** Those are your service's
  job. This package's entitlement model gives you a place to attach your own
  eligibility/attribution data (`source`, `externalRef`), but it never
  contacts a payment provider, courier, or auth system.

## Fairness

- Every shuffle uses Node's `crypto.randomInt` (Fisher–Yates over the full,
  quantity-preserving pool — see `src/rng.ts`). If the platform's CSPRNG
  fails, box creation fails with `RNG_FAILURE`; it never falls back to
  `Math.random()`.
- `createBox` takes only prize ids and quantities. There is no seed,
  RNG-injection, weight, or forced-outcome parameter in this package's
  public API, and passing unknown fields is a validation error, not a
  silently-ignored no-op.
- A ticket's assigned prize is fixed the instant the box is created. Drawing
  a ticket always pays out exactly that prize.
- `computeAssignmentCommitment` / `verifyAssignmentCommitment` (and
  `kuji_reconcile` in the Postgres adapter) let you detect after the fact if
  the stored assignment was ever altered outside this package's own code
  path — tamper-evidence, not a public zero-knowledge proof.

## Which adapter should I use?

| | `unakuji-fair-draw/memory` | `unakuji-fair-draw/postgres` |
|---|---|---|
| Durability | None — lost on process exit | Full (Postgres) |
| Multi-process / multi-server safe | No (single-process mutex only) | Yes (row locks in the DB) |
| Reservations, entitlements, queue, audit | Reservations only; the rest live only in the Postgres adapter | Full |
| Use for | Tests, prototyping, examples | Anything real |

The pure functions in `src/core/` and `src/reservations/` are storage-free
and used by the memory adapter directly; the Postgres adapter is a separate,
from-scratch transactional implementation of the full contract (see
[PostgreSQL reference implementation](#postgresql-reference-implementation)) —
passing the memory adapter's tests does not certify production readiness.

## Entitlements are opt-in

`draw()`'s `entitlementIds` parameter is optional. If your integration
already knows how to decide "is this holder allowed to draw right now"
(your own purchase/session state), just omit it and call `draw()` with a
`holder` id — the engine still guarantees fair assignment, atomicity,
idempotency, and payout correctness on its own.

If you want the engine to also enforce "you need a valid, unconsumed pass to
draw," issue entitlements (`issueEntitlement`) from wherever your purchase
flow, admin console, or event/comp system decides someone earned one — the
`source`/`externalRef` fields are opaque tags for your own bookkeeping, not
interpreted by the engine — and pass their ids into `draw()`. A `kind:
'single_use'` entitlement pays for exactly one ticket and is then consumed;
a `kind: 'unlimited'` entitlement can be reused indefinitely (e.g. an
operator's reusable draw pass), and is still subject to every other rule
(box status, ticket availability, queue turn).

There is deliberately no "draw without presenting any entitlement, bypassing
whatever eligibility check the host wanted" admin shortcut — if you need an
operator to be able to draw, issue that operator an entitlement (of whatever
`kind`/`source` you like) and have them go through the same `draw()` path as
everyone else.

## PostgreSQL reference implementation

Apply `db/001_tables.sql` through `db/005_roles.sql` in order (plain SQL, no
migration framework assumed) — see
[`examples/postgres/README.md`](examples/postgres/README.md) for a
docker-compose walkthrough.

The `kuji_*` functions are `SECURITY DEFINER` with a pinned `search_path`, so
they reach the tables as their owner and callers never need table privileges
of their own. `db/005_roles.sql` splits those callers into a participant-facing
`unakuji_app` role and an operator `unakuji_admin` role and grants each nothing
but EXECUTE — no INSERT, no UPDATE, not even SELECT.

That is deliberate, and it is the reason the functions are `SECURITY DEFINER`.
While they ran as the caller, a role able to run `kuji_draw()` necessarily also
held INSERT on `payout_ledger` and `purchase_requests`, and `kuji_get_result()`
returns `purchase_requests.result` verbatim — so that INSERT was a second,
unaudited way to produce a draw result. The privileges the functions needed
*were* the intervention path. Withholding SELECT matters for the same reason:
`tickets.prize_id` for an undrawn ticket is exactly what a participant must not
be able to read, whatever the public API returns.

The functions do not check who is calling them — `p_actor` is an audit label,
not a verified identity — so EXECUTE is the authorization. Note that Postgres
grants EXECUTE to `PUBLIC` by default; `005_roles.sql` revokes it first, and a
schema that skips this file leaves every function callable by every role.

If you ever change a function's *parameter types* in your own fork/revision,
`DROP FUNCTION` it first before re-creating it. `CREATE OR REPLACE FUNCTION`
only replaces a function with the exact same argument types — a signature
change adds a second overload instead of replacing the first, and Postgres's
overload resolution can then silently pick the stale one for calls that
don't explicitly cast their arguments (independent review of this package
caught exactly this on a long-lived dev database after a parameter type was
changed during development; a fresh `psql -f` apply of the files as shipped
does not have this problem, since each file only defines one version of
each function).

```ts
import { Pool } from 'pg';
import { PostgresKujiEngine } from 'unakuji-fair-draw/postgres';

const engine = new PostgresKujiEngine(new Pool({ connectionString: process.env.DATABASE_URL }));
```

### Concurrency model

Every state-changing call (`draw`, `reserveTickets`, `joinQueue`, ...) is
exactly one SQL function call (`db/002_functions.sql`,
`db/003_queue_functions.sql`), and each function takes `SELECT ... FOR
UPDATE` on the box row first. That serializes every write for a given box
through one lock — simple to reason about and to prove correct, at the cost
of not parallelizing writes within a single box (reads, and writes to
*different* boxes, are unaffected). For a kuji-style box this is the right
tradeoff: correctness under real concurrent draws matters far more than
write throughput on one box.

Because the SQL function is the transaction boundary, the queue-turn
re-check and the ticket-availability check inside `draw()` happen in the
same transaction as the ticket consumption itself — there is no window
between "check" and "act" for another request to invalidate the check.

### Idempotency & recovery

Every state-changing call takes a caller-generated `requestId`. A row is
written to `purchase_requests` **only as part of the same transaction that
completes the operation** — so if your server crashes or the connection
drops after Postgres commits but before your code sees the response, retry
with the same `requestId` (and the same input): the retry finds the
committed row and returns the original result instead of drawing again. If
the first attempt failed validation (nothing committed), a retry with the
same `requestId` and corrected input just runs fresh. Reusing a `requestId`
with genuinely different input is rejected with `REQUEST_CONFLICT`, on
purpose — it usually means a bug in the caller (id collision or a retry
that accidentally changed the payload).

`kuji_reconcile(boxId)` / `engine.reconcile(boxId)` is a read-only
consistency check: ticket-count vs `total_tickets`, consumed-count vs
payout-ledger rows, per-prize payout vs configured quantity, last-one
award count, and the assignment-commitment hash. Run it after a box closes,
or periodically, or on demand.

### Background jobs

Three functions are meant to be called on whatever schedule your host
already runs (cron, a worker, `setInterval` — this package does not
register its own):

- `kuji_open_scheduled_boxes()` / `engine.openScheduledBoxes()` — promotes
  `upcoming` boxes past their `sale_opens_at` to `on_sale`.
- `kuji_expire_reservations()` / `engine.expireReservations()` — sweeps
  expired holds back to `available`. Not required for correctness (`draw`
  always re-checks expiry itself), only for freeing up the public "remaining
  tickets" view promptly.
- `kuji_advance_queue()` / `engine.advanceQueue()` — expires stale queue
  turns and promotes the next holder. Also not required for correctness
  (`draw` always re-validates the current turn) — only for keeping the
  queue moving without everyone polling `draw` to find out their turn expired.

### Combining a draw with your own side effects in one transaction

`PostgresKujiEngine` never opens a transaction that spans more than one
call — each method is one round trip, and the SQL function itself is the
transaction boundary. If you need a draw to commit atomically together with
your own side effect (e.g. deducting an internal balance in the same
database), call the `kuji_draw(...)` SQL function directly inside your own
transaction against the same connection/pool, instead of going through
`PostgresKujiEngine.draw()`. The function is plain SQL — nothing about it
requires going through this package's TypeScript wrapper.

### Trust boundary

This package assumes the process calling it (your backend server) is
trusted, and that the database is only ever reached through it — there is
no browser-facing API, no anonymous database role, and no row-level
security policy here, because none of those are needed for that model (see
the SQL files' comments). `holder`/`actor` parameters are opaque ids your
server has already authenticated; this package checks *ownership* (does
this holder own this entitlement/reservation/result) but never
*authentication* itself. Bypassing this package's functions and writing to
its tables directly is, definitionally, outside what it can protect against.

## Error codes

Every failure is a `KujiError` with a stable `.code` (see `src/errors.ts`):
`INVALID_INPUT`, `BOX_NOT_FOUND`, `BOX_ALREADY_EXISTS`, `BOX_NOT_ON_SALE`,
`SOLD_OUT`, `TICKET_NOT_FOUND`, `TICKET_UNAVAILABLE`, `RESERVATION_CONFLICT`,
`RESERVATION_EXPIRED`, `RESERVATION_NOT_FOUND`, `FORBIDDEN`,
`ENTITLEMENT_NOT_FOUND`, `ENTITLEMENT_INVALID`,
`ENTITLEMENT_ALREADY_CONSUMED`, `ENTITLEMENT_LIMIT_EXCEEDED`,
`ENTITLEMENT_TICKET_MISMATCH`, `QUEUE_NOT_REQUIRED`, `QUEUE_ALREADY_JOINED`,
`QUEUE_TURN_REQUIRED`, `QUEUE_ENTRY_NOT_FOUND`, `REQUEST_CONFLICT`,
`RNG_FAILURE`, `INVALID_STATE`.

```ts
import { isKujiError } from 'unakuji-fair-draw';

try {
  await engine.draw(boxId, input);
} catch (err) {
  if (isKujiError(err) && err.code === 'TICKET_UNAVAILABLE') {
    // ...
  }
  throw err;
}
```

## Running the tests

```bash
npm install
npm run typecheck && npm run lint && npm run build
npm run test:unit

# Postgres integration + concurrency tests need a real database:
docker compose -f examples/postgres/docker-compose.yml up -d
DATABASE_URL=postgresql://postgres:devpass@localhost:55432/unakuji ./examples/postgres/apply-schema.sh
DATABASE_URL=postgresql://postgres:devpass@localhost:55432/unakuji npm run test:postgres
```

`tests/unit/` covers the pure algorithm and the memory adapter (quantity
preservation, atomicity, idempotency, last-one, in-process concurrency).
`tests/postgres/` covers the same contract against a real database, plus
what only a real database can prove: genuinely concurrent draws for the
same ticket, reservation/queue races, and crash-recovery-style retries.

## License

MIT — see [LICENSE](LICENSE).
