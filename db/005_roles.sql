-- unakuji-fair-draw: optional least-privilege application role.
--
-- This file is optional — if your host project already manages its own DB
-- roles/credentials, skip it and just point your existing connection at
-- this schema; nothing else here depends on a role named exactly this.
--
-- Why grant EXECUTE on functions but only SELECT/INSERT/UPDATE (no DELETE)
-- on tables: every state change this engine ever makes goes through the
-- kuji_* functions in 002-004, and none of them delete rows (cancellation
-- and voiding are represented as status changes, never row removal, so the
-- audit/payout history is never destructible through this role). If you
-- build an operator tool that purges old test boxes, grant DELETE to a
-- separate, more privileged role for that tool specifically — don't widen
-- this one.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'unakuji_app') THEN
    CREATE ROLE unakuji_app LOGIN PASSWORD 'change_me_before_deploying';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO unakuji_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO unakuji_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO unakuji_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO unakuji_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO unakuji_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO unakuji_app;
