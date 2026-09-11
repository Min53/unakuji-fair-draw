-- unakuji-fair-draw: optional least-privilege application roles.
--
-- This file is optional — if your host project already manages its own DB
-- roles/credentials, skip it and just point your existing connection at
-- this schema; nothing else here depends on roles named exactly these.
--
-- Two roles, because two very different things talk to this schema:
--
--   unakuji_app    the participant-facing server: draws, reservations, queue
--   unakuji_admin  operator tooling: creating, opening, pausing, canceling
--
-- The kuji_* functions carry no authorization check of their own. p_actor is
-- a label written to audit_log, not an identity that is verified. That is a
-- deliberate boundary — this engine does not know who your users are — but it
-- means EXECUTE *is* the authorization, and it has to be granted like one.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, so a schema
-- that only ever runs GRANT would leave every function callable by every
-- role. The REVOKE below is therefore the load-bearing line in this file:
-- without it, the participant-facing role can call kuji_cancel_box() and
-- kuji_create_box() no matter what else is written here.
--
-- Table grants are column-level for the same reason. Every state change goes
-- through the functions, and those functions only ever write the columns
-- listed below, so the columns that decide or attest a result are never
-- granted to anyone:
--
--   tickets.prize_id            -- which prize a ticket holds
--   tickets.box_id/ticket_no    -- which ticket a row *is*
--   boxes.assignment_commitment -- the fingerprint of the whole assignment
--   boxes.assignment_salt       -- and its salt
--   boxes.total_tickets         -- the size the commitment was taken over
--
-- They are written once, at box creation, by INSERT. After that neither role
-- can change them at all — not through a bug, not through a compromised
-- application process, not through an operator holding either credential.
-- Postgres refuses the statement before any trigger or function runs.
--
-- No DELETE is granted to either role: cancellation and voiding are status
-- changes, never row removal, so payout and audit history is not destructible
-- here. If you build an operator tool that purges old test boxes, grant DELETE
-- to a separate, more privileged role for that tool specifically.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'unakuji_app') THEN
    CREATE ROLE unakuji_app LOGIN PASSWORD 'change_me_before_deploying';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'unakuji_admin') THEN
    CREATE ROLE unakuji_admin LOGIN PASSWORD 'change_me_before_deploying';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO unakuji_app, unakuji_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO unakuji_app, unakuji_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO unakuji_app, unakuji_admin;

-- Take back the default. Nothing below is meaningful until this has run.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- unakuji_app — what a participant's request can reach.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  kuji_public_box, kuji_audit,
  kuji_draw, kuji_reserve_tickets, kuji_release_reservation, kuji_expire_reservations,
  kuji_issue_entitlement,
  kuji_join_queue, kuji_leave_queue, kuji_queue_status,
  kuji_promote_next_in_queue, kuji_advance_queue,
  kuji_get_result, kuji_get_holder_results, kuji_reconcile
TO unakuji_app;

GRANT INSERT ON audit_log, purchase_requests, payout_ledger, last_one_awards,
                queue_entries, entitlements
  TO unakuji_app;

GRANT UPDATE (status, updated_at, last_one_awarded)              ON boxes         TO unakuji_app;
GRANT UPDATE (status, reserved_by, reserved_until, consumed_at)  ON tickets       TO unakuji_app;
GRANT UPDATE (status, consumed_at, consumed_ticket_no)           ON entitlements  TO unakuji_app;
GRANT UPDATE (status, turn_expires_at, updated_at)               ON queue_entries TO unakuji_app;

-- Deliberately absent from unakuji_app: INSERT on boxes, box_prizes and
-- tickets. Only kuji_create_box writes those, so a compromised participant
-- server cannot mint a new box or a new assignment to draw from.

-- ---------------------------------------------------------------------------
-- unakuji_admin — operator tooling. Changes a box's lifecycle, never a result.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  kuji_public_box, kuji_audit,
  kuji_create_box,
  kuji_open_box, kuji_schedule_box_open, kuji_open_scheduled_boxes,
  kuji_pause_box, kuji_resume_box, kuji_cancel_box, kuji_close_box,
  kuji_cancel_entitlement,
  kuji_get_result, kuji_get_holder_results, kuji_reconcile
TO unakuji_admin;

GRANT INSERT ON boxes, box_prizes, tickets, audit_log TO unakuji_admin;

GRANT UPDATE (status, updated_at, sale_opens_at, last_one_awarded,
              paused_at, pause_reason, ended_at, end_reason,
              canceled_at, cancel_reason)                        ON boxes        TO unakuji_admin;
GRANT UPDATE (status, voided_at, void_reason)                    ON entitlements TO unakuji_admin;

-- Deliberately absent from unakuji_admin: kuji_draw and the reservation and
-- queue functions. An operator account cannot draw on a participant's behalf.

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO unakuji_app, unakuji_admin;
