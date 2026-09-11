-- unakuji-fair-draw: least-privilege application roles.
--
-- Optional in the sense that you may wire your own credentials instead, but
-- the model here is the one the engine is designed around, and skipping it
-- leaves every function callable by every role (see the REVOKE below).
--
-- Two roles, because two very different things talk to this schema:
--
--   unakuji_app    the participant-facing server: draws, reservations, queue
--   unakuji_admin  operator tooling: creating, opening, pausing, canceling
--
-- Neither role is granted anything on any table. Not INSERT, not UPDATE, not
-- even SELECT. The kuji_* functions in 002-004 are SECURITY DEFINER, so they
-- run with their owner's rights and reach the tables themselves; the callers
-- only ever hold EXECUTE.
--
-- That is the whole point of this file. While the functions ran as the caller,
-- a role that could run kuji_draw() necessarily also held INSERT on
-- payout_ledger and purchase_requests — and kuji_get_result() hands back
-- purchase_requests.result verbatim, so that INSERT was a second, unaudited
-- way to produce a result. No amount of narrowing the grants closed that:
-- the privileges the functions needed *were* the intervention path. Granting
-- EXECUTE and nothing else is what closes it. Now the only way to write a
-- draw result is kuji_draw(), and the only way to read another participant's
-- is not to.
--
-- Withholding SELECT matters too: tickets.prize_id for an undrawn ticket is
-- exactly the information a participant must not have, and a role with blanket
-- SELECT has it regardless of what the public API returns.
--
-- The kuji_* functions carry no authorization check of their own. p_actor is
-- a label written to audit_log, not a verified identity — this engine does not
-- know who your users are. So EXECUTE is the authorization, and the split
-- below is where it is decided.

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

-- SECURITY DEFINER functions resolve unqualified names through the search_path
-- pinned on each function (pg_catalog, public). Nobody but the owner may create
-- objects in public, so that path cannot be shadowed. Postgres 15+ does this by
-- default; the REVOKE keeps older servers honest.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO unakuji_app, unakuji_admin;

-- Take back the default. Postgres grants EXECUTE on functions to PUBLIC, so
-- without this every grant below is decoration and every role can call
-- everything. Scoped to kuji_% on purpose: extensions install into public too,
-- and revoking EXECUTE on ALL FUNCTIONS takes pgcrypto's digest() away as well,
-- which breaks kuji_reconcile(). Looping also means a function added later is
-- covered by re-running this file, with no list here to forget to update.
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'kuji\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn.signature);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- unakuji_app — what a participant's request can reach.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  kuji_public_box,
  kuji_draw, kuji_reserve_tickets, kuji_release_reservation, kuji_expire_reservations,
  kuji_issue_entitlement,
  kuji_join_queue, kuji_leave_queue, kuji_queue_status,
  kuji_promote_next_in_queue, kuji_advance_queue,
  kuji_get_result, kuji_get_holder_results, kuji_reconcile
TO unakuji_app;

-- Deliberately absent: kuji_create_box and every box lifecycle function. A
-- compromised participant server cannot mint a new assignment to draw from,
-- nor cancel or close a box that is selling.

-- ---------------------------------------------------------------------------
-- unakuji_admin — operator tooling. Changes a box's lifecycle, never a result.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  kuji_public_box,
  kuji_create_box,
  kuji_open_box, kuji_schedule_box_open, kuji_open_scheduled_boxes,
  kuji_pause_box, kuji_resume_box, kuji_cancel_box, kuji_close_box,
  kuji_cancel_entitlement,
  kuji_get_result, kuji_get_holder_results, kuji_reconcile
TO unakuji_admin;

-- Deliberately absent: kuji_draw and the reservation and queue functions. An
-- operator account cannot draw on a participant's behalf.

-- kuji_audit is not granted to anyone: it is called by the other functions,
-- which reach it as their owner. Nothing should be writing audit rows directly.
