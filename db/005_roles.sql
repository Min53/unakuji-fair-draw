-- unakuji-fair-draw: optional least-privilege application role.
--
-- This file is optional — if your host project already manages its own DB
-- roles/credentials, skip it and just point your existing connection at
-- this schema; nothing else here depends on a role named exactly this.
--
-- The grants below are deliberately column-level. Every state change this
-- engine makes goes through the kuji_* functions in 002-004, and those
-- functions only ever write the columns listed here. Granting UPDATE on
-- whole tables would hand this role a second, unaudited way to change a
-- draw result: a plain `UPDATE tickets SET prize_id = ...` bypasses every
-- function, every audit row and the assignment commitment. So the columns
-- that decide or attest a result are simply never granted:
--
--   tickets.prize_id            -- which prize a ticket holds
--   tickets.box_id/ticket_no    -- which ticket a row *is*
--   boxes.assignment_commitment -- the fingerprint of the whole assignment
--   boxes.assignment_salt       -- and its salt
--   boxes.total_tickets         -- the size the commitment was taken over
--
-- They are written once, at box creation, by INSERT. After that this role
-- cannot change them at all — not through a bug, not through a compromised
-- application process, not through an operator with the app credentials.
-- Postgres refuses the statement before any trigger or function runs.
--
-- No DELETE is granted either: cancellation and voiding are status changes,
-- never row removal, so payout and audit history is not destructible here.
-- If you build an operator tool that purges old test boxes, grant DELETE to
-- a separate, more privileged role for that tool specifically — don't widen
-- this one.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'unakuji_app') THEN
    CREATE ROLE unakuji_app LOGIN PASSWORD 'change_me_before_deploying';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO unakuji_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO unakuji_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO unakuji_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO unakuji_app;

-- Rows are created whole, by the kuji_* functions.
GRANT INSERT ON boxes, box_prizes, tickets, entitlements, queue_entries,
                purchase_requests, payout_ledger, last_one_awards, audit_log
  TO unakuji_app;

-- ...and afterwards only these columns may ever change.
GRANT UPDATE (status, updated_at, sale_opens_at, last_one_awarded,
              paused_at, pause_reason, ended_at, end_reason,
              canceled_at, cancel_reason)                      ON boxes         TO unakuji_app;
GRANT UPDATE (status, reserved_by, reserved_until, consumed_at) ON tickets       TO unakuji_app;
GRANT UPDATE (status, consumed_at, consumed_ticket_no,
              voided_at, void_reason)                          ON entitlements   TO unakuji_app;
GRANT UPDATE (status, turn_expires_at, updated_at)             ON queue_entries  TO unakuji_app;
-- box_prizes, purchase_requests, payout_ledger, last_one_awards and audit_log
-- are append-only for this role: no UPDATE is granted at all.

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO unakuji_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO unakuji_app;
