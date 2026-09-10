-- unakuji-fair-draw: PostgreSQL reference schema
-- Requires PostgreSQL 13+. Apply 001..004 in order (plain SQL files, no
-- migration framework assumed — use whatever your host project already uses
-- to run them, e.g. `psql -f`, node-pg-migrate, Prisma migrate diff, etc.)
--
-- Design notes (see README "PostgreSQL reference implementation" for more):
--  * All ids the host controls (box id, holder, prize id) are `text`. The
--    engine never generates a box id; the caller supplies one.
--  * There is no RLS and no anonymous/public role here on purpose: this
--    schema is meant to be reached only from a trusted host server process
--    holding normal application DB credentials, never from a browser
--    talking to Postgres directly. See db/004_roles.sql for the one
--    least-privilege role this package does define.
--  * Every invariant that matters is enforced twice: once by application
--    logic in db/002_functions.sql, and again by a CHECK/UNIQUE/FK
--    constraint here, so a bug in the function can't silently corrupt data.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- boxes
-- ============================================================================
CREATE TABLE boxes (
  id                     text PRIMARY KEY,
  status                 text NOT NULL DEFAULT 'preparing'
                         CHECK (status IN ('preparing','upcoming','on_sale','paused','sold_out','ended','canceled')),
  total_tickets          integer NOT NULL CHECK (total_tickets > 0),
  last_one_prize_id      text NULL,
  last_one_awarded       boolean NOT NULL DEFAULT false,
  final_queue_threshold  integer NOT NULL DEFAULT 0 CHECK (final_queue_threshold >= 0),
  -- Tamper-evidence for the ticket assignment computed at creation time; see
  -- src/core/integrity.ts and kuji_reconcile() in 004_admin_functions.sql.
  assignment_commitment  text NOT NULL,
  assignment_salt        text NOT NULL,
  sale_opens_at          timestamptz NULL,
  paused_at              timestamptz NULL,
  pause_reason           text NULL,
  canceled_at            timestamptz NULL,
  cancel_reason          text NULL,
  ended_at               timestamptz NULL,
  end_reason             text NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN boxes.status IS
  'preparing: just created, not yet visible/openable. upcoming: scheduled via sale_opens_at, waiting for kuji_open_scheduled_boxes(). on_sale: draws/reservations/queue accepted. paused: temporarily blocks new draws/reservations/queue joins but existing results remain queryable. sold_out: every ticket consumed. ended: force-closed by an operator (kuji_close_box). canceled: retired before/without completing sales.';

-- ============================================================================
-- box_prizes — quantities as configured at creation. Immutable after insert;
-- there is intentionally no UPDATE path (changing quantities after tickets
-- have been assigned would break the quantity-preserving guarantee).
-- ============================================================================
CREATE TABLE box_prizes (
  box_id    text NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  prize_id  text NOT NULL,
  quantity  integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (box_id, prize_id)
);

-- ============================================================================
-- tickets — one row per physical ticket, prize_id fixed forever at creation.
-- There is no column and no function anywhere in this schema that can change
-- a ticket's prize_id after insert: that is the schema-level enforcement of
-- "the prize assigned to a ticket is the prize that gets paid out" (see
-- README "What this engine deliberately does not do").
-- ============================================================================
CREATE TABLE tickets (
  box_id          text NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  ticket_no       integer NOT NULL CHECK (ticket_no > 0),
  prize_id        text NOT NULL,
  status          text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','consumed')),
  reserved_by     text NULL,
  reserved_until  timestamptz NULL,
  consumed_at     timestamptz NULL,
  PRIMARY KEY (box_id, ticket_no),
  FOREIGN KEY (box_id, prize_id) REFERENCES box_prizes (box_id, prize_id),
  CHECK ((status = 'reserved') = (reserved_by IS NOT NULL AND reserved_until IS NOT NULL)),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX tickets_box_status_idx ON tickets (box_id, status);
CREATE INDEX tickets_reservation_expiry_idx ON tickets (reserved_until) WHERE status = 'reserved';

-- ============================================================================
-- entitlements — the generalized "draw pass" concept. `kind='single_use'`
-- covers per-purchase / per-order codes (and admin-/event-issued comp
-- entries — the engine does not care about `source`, it's an opaque tag the
-- host can filter/report on). `kind='unlimited'` covers reusable "master"
-- passes: they never transition to 'consumed', so usage accounting for them
-- comes from counting payout_ledger rows instead.
-- ============================================================================
CREATE TABLE entitlements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id        text NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  holder        text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('single_use','unlimited')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','void','expired')),
  source        text NULL,
  external_ref  text NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NULL,
  consumed_at   timestamptz NULL,
  consumed_ticket_no integer NULL,
  voided_at     timestamptz NULL,
  void_reason   text NULL,
  CHECK (kind <> 'unlimited' OR status <> 'consumed')
);
CREATE INDEX entitlements_box_holder_idx ON entitlements (box_id, holder);
CREATE INDEX entitlements_box_status_idx ON entitlements (box_id, status);
CREATE INDEX entitlements_external_ref_idx ON entitlements (box_id, external_ref) WHERE external_ref IS NOT NULL;

-- ============================================================================
-- queue_entries — final-segment turn-taking. At most one open (waiting or
-- active) entry per (box, holder), enforced below so a holder can't queue
-- twice and skip the line. turn_ttl_seconds is remembered from join time so
-- that later promoting a *waiting* entry to *active* (in kuji_leave_queue or
-- kuji_advance_queue) grants it the same hold duration the holder was
-- promised, not some other default.
-- ============================================================================
CREATE TABLE queue_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id            text NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  holder            text NOT NULL,
  "position"        bigint NOT NULL,
  status            text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','expired','left','canceled','completed')),
  turn_ttl_seconds  int NOT NULL CHECK (turn_ttl_seconds > 0 AND turn_ttl_seconds <= 1800),
  turn_expires_at   timestamptz NULL,
  joined_at         timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX queue_entries_open_per_holder_uq ON queue_entries (box_id, holder) WHERE status IN ('waiting','active');
CREATE INDEX queue_entries_box_position_idx ON queue_entries (box_id, "position");
CREATE INDEX queue_entries_active_expiry_idx ON queue_entries (turn_expires_at) WHERE status = 'active';

-- ============================================================================
-- purchase_requests — idempotency ledger. A row exists here IF AND ONLY IF
-- the corresponding request already committed successfully; failed attempts
-- never appear here because the whole transaction (including this insert)
-- rolls back with them. That is what makes "retry after a dropped
-- connection" safe: the retry either finds this row (request already
-- succeeded — return the cached result) or doesn't (nothing committed —
-- safe to run again from scratch).
-- ============================================================================
CREATE TABLE purchase_requests (
  box_id        text NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  request_id    text NOT NULL,
  action        text NOT NULL CHECK (action IN ('draw','reserve','join_queue')),
  holder        text NOT NULL,
  payload_hash  text NOT NULL,
  result        jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (box_id, request_id)
);

-- ============================================================================
-- payout_ledger — the record of what was actually paid out. UNIQUE(box_id,
-- ticket_no) is the schema-level guarantee that a ticket is paid out at
-- most once, independent of any application-level bug.
-- ============================================================================
CREATE TABLE payout_ledger (
  id              bigserial PRIMARY KEY,
  box_id          text NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  ticket_no       integer NOT NULL,
  prize_id        text NOT NULL,
  holder          text NOT NULL,
  entitlement_id  uuid NULL REFERENCES entitlements(id),
  request_id      text NOT NULL,
  drawn_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (box_id, ticket_no),
  FOREIGN KEY (box_id, ticket_no) REFERENCES tickets (box_id, ticket_no)
);
CREATE INDEX payout_ledger_box_holder_idx ON payout_ledger (box_id, holder);

-- ============================================================================
-- last_one_awards — PRIMARY KEY(box_id) alone enforces "at most one award
-- per box" at the schema level, independent of application logic.
-- ============================================================================
CREATE TABLE last_one_awards (
  box_id      text PRIMARY KEY REFERENCES boxes(id) ON DELETE CASCADE,
  ticket_no   integer NOT NULL,
  prize_id    text NOT NULL,
  holder      text NOT NULL,
  request_id  text NOT NULL,
  awarded_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (box_id, ticket_no) REFERENCES tickets (box_id, ticket_no)
);

-- ============================================================================
-- audit_log — every admin/state-changing action funnels through
-- kuji_audit() in 002_functions.sql. Deliberately has no "toggle a flag with
-- no audit row" escape hatch anywhere in this schema.
-- ============================================================================
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  box_id      text NULL,
  action      text NOT NULL,
  actor       text NULL,
  reason      text NULL,
  before      jsonb NULL,
  after       jsonb NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_box_idx ON audit_log (box_id);
CREATE INDEX audit_log_created_idx ON audit_log (created_at);
