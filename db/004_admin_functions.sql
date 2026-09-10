-- unakuji-fair-draw: lifecycle, recovery/consistency, and result-query functions

-- ============================================================================
-- Lifecycle
-- ============================================================================
CREATE OR REPLACE FUNCTION kuji_open_box(p_box_id text, p_actor text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_box boxes%ROWTYPE;
BEGIN
  SELECT * INTO v_box FROM boxes WHERE id = p_box_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;
  IF v_box.status NOT IN ('preparing', 'upcoming') THEN
    RAISE EXCEPTION 'INVALID_STATE: box % cannot open from status %', p_box_id, v_box.status;
  END IF;
  UPDATE boxes SET status = 'on_sale', updated_at = now() WHERE id = p_box_id;
  PERFORM kuji_audit(p_box_id, 'open_box', p_actor, NULL, to_jsonb(v_box.status), '"on_sale"'::jsonb);
  RETURN kuji_public_box(p_box_id);
END;
$$;

CREATE OR REPLACE FUNCTION kuji_schedule_box_open(p_box_id text, p_opens_at timestamptz, p_actor text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_box boxes%ROWTYPE;
BEGIN
  SELECT * INTO v_box FROM boxes WHERE id = p_box_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;
  IF v_box.status NOT IN ('preparing', 'upcoming') THEN
    RAISE EXCEPTION 'INVALID_STATE: box % cannot be scheduled from status %', p_box_id, v_box.status;
  END IF;
  IF p_opens_at <= now() THEN
    RAISE EXCEPTION 'INVALID_INPUT: opensAt must be in the future';
  END IF;
  UPDATE boxes SET status = 'upcoming', sale_opens_at = p_opens_at, updated_at = now() WHERE id = p_box_id;
  PERFORM kuji_audit(p_box_id, 'schedule_box_open', p_actor, NULL, to_jsonb(v_box.sale_opens_at), to_jsonb(p_opens_at));
  RETURN kuji_public_box(p_box_id);
END;
$$;

-- Idempotent bulk transition: call this from whatever scheduler the host
-- already runs (pg_cron, a worker queue, a plain setInterval) — the engine
-- does not register its own cron job. Only ever moves upcoming -> on_sale;
-- never touches paused/canceled/ended boxes.
CREATE OR REPLACE FUNCTION kuji_open_scheduled_boxes()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_count int;
BEGIN
  WITH due AS (
    SELECT id FROM boxes WHERE status = 'upcoming' AND sale_opens_at <= now() FOR UPDATE
  )
  UPDATE boxes SET status = 'on_sale', updated_at = now() WHERE id IN (SELECT id FROM due);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION kuji_pause_box(p_box_id text, p_actor text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_box boxes%ROWTYPE;
BEGIN
  SELECT * INTO v_box FROM boxes WHERE id = p_box_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;
  IF v_box.status <> 'on_sale' THEN
    RAISE EXCEPTION 'INVALID_STATE: box % cannot be paused from status %', p_box_id, v_box.status;
  END IF;
  UPDATE boxes SET status = 'paused', paused_at = now(), pause_reason = p_reason, updated_at = now() WHERE id = p_box_id;
  PERFORM kuji_audit(p_box_id, 'pause_box', p_actor, p_reason, '"on_sale"'::jsonb, '"paused"'::jsonb);
  RETURN kuji_public_box(p_box_id);
END;
$$;

CREATE OR REPLACE FUNCTION kuji_resume_box(p_box_id text, p_actor text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_box boxes%ROWTYPE;
BEGIN
  SELECT * INTO v_box FROM boxes WHERE id = p_box_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;
  IF v_box.status <> 'paused' THEN
    RAISE EXCEPTION 'INVALID_STATE: box % cannot resume from status %', p_box_id, v_box.status;
  END IF;
  UPDATE boxes SET status = 'on_sale', paused_at = NULL, pause_reason = NULL, updated_at = now() WHERE id = p_box_id;
  PERFORM kuji_audit(p_box_id, 'resume_box', p_actor, NULL, '"paused"'::jsonb, '"on_sale"'::jsonb);
  RETURN kuji_public_box(p_box_id);
END;
$$;

-- p_allow_real_sales must be explicitly true to cancel a box that has already
-- paid out at least one ticket — mirrors the "don't silently wipe a box with
-- real draws already on it" guard this engine is modeled on.
CREATE OR REPLACE FUNCTION kuji_cancel_box(p_box_id text, p_actor text, p_reason text, p_allow_real_sales boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_box boxes%ROWTYPE;
  v_has_sales boolean;
BEGIN
  SELECT * INTO v_box FROM boxes WHERE id = p_box_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;
  IF v_box.status IN ('canceled', 'ended') THEN
    RAISE EXCEPTION 'INVALID_STATE: box % is already terminal (status %)', p_box_id, v_box.status;
  END IF;

  SELECT EXISTS (SELECT 1 FROM payout_ledger WHERE box_id = p_box_id) INTO v_has_sales;
  IF v_has_sales AND NOT p_allow_real_sales THEN
    RAISE EXCEPTION 'INVALID_STATE: box % already has completed draws; pass allowRealSales to cancel anyway', p_box_id;
  END IF;

  UPDATE boxes SET status = 'canceled', canceled_at = now(), cancel_reason = p_reason, updated_at = now() WHERE id = p_box_id;
  PERFORM kuji_audit(p_box_id, 'cancel_box', p_actor, p_reason, to_jsonb(v_box.status), '"canceled"'::jsonb);
  RETURN kuji_public_box(p_box_id);
END;
$$;

-- Force-close: for operational situations (e.g. a deadlocked final queue)
-- where the box must stop accepting new draws right now regardless of
-- remaining tickets. Existing results remain fully queryable afterward.
CREATE OR REPLACE FUNCTION kuji_close_box(p_box_id text, p_actor text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_box boxes%ROWTYPE;
BEGIN
  SELECT * INTO v_box FROM boxes WHERE id = p_box_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;
  IF v_box.status IN ('canceled', 'ended') THEN
    RAISE EXCEPTION 'INVALID_STATE: box % is already terminal (status %)', p_box_id, v_box.status;
  END IF;
  UPDATE boxes SET status = 'ended', ended_at = now(), end_reason = p_reason, updated_at = now() WHERE id = p_box_id;
  PERFORM kuji_audit(p_box_id, 'close_box', p_actor, p_reason, to_jsonb(v_box.status), '"ended"'::jsonb);
  RETURN kuji_public_box(p_box_id);
END;
$$;

-- ============================================================================
-- Result queries — both are scoped to p_holder so a caller can never read
-- another holder's request result or payout history (IDOR protection lives
-- in the WHERE clause, not in the caller remembering to check).
-- ============================================================================
CREATE OR REPLACE FUNCTION kuji_get_result(p_box_id text, p_holder text, p_request_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT result FROM purchase_requests
  WHERE box_id = p_box_id AND request_id = p_request_id AND holder = p_holder;
$$;

CREATE OR REPLACE FUNCTION kuji_get_holder_results(p_box_id text, p_holder text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'ticketNo', ticket_no, 'prizeId', prize_id, 'requestId', request_id, 'drawnAt', to_jsonb(drawn_at)
    ) ORDER BY drawn_at), '[]'::jsonb)
  FROM payout_ledger WHERE box_id = p_box_id AND holder = p_holder;
$$;

-- ============================================================================
-- Consistency check. Read-only; never mutates. Run it on demand or on a
-- schedule (e.g. after each box closes) — see README "Recovery & consistency".
-- ============================================================================
CREATE OR REPLACE FUNCTION kuji_reconcile(p_box_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_box boxes%ROWTYPE;
  v_ticket_count int;
  v_consumed_count int;
  v_payout_count int;
  v_last_one_count int;
  v_prize_overdraw_count int;
  v_commitment_ok boolean;
  v_current_assignment jsonb;
  v_issues text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_box FROM boxes WHERE id = p_box_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;

  SELECT count(*) INTO v_ticket_count FROM tickets WHERE box_id = p_box_id;
  IF v_ticket_count <> v_box.total_tickets THEN
    v_issues := v_issues || format('ticket row count %s does not match boxes.total_tickets %s', v_ticket_count, v_box.total_tickets);
  END IF;

  SELECT count(*) INTO v_consumed_count FROM tickets WHERE box_id = p_box_id AND status = 'consumed';
  SELECT count(*) INTO v_payout_count FROM payout_ledger WHERE box_id = p_box_id;
  IF v_consumed_count <> v_payout_count THEN
    v_issues := v_issues || format('consumed ticket count %s does not match payout_ledger row count %s', v_consumed_count, v_payout_count);
  END IF;

  SELECT count(*) INTO v_prize_overdraw_count
    FROM (
      SELECT pl.prize_id, count(*) AS paid, bp.quantity
      FROM payout_ledger pl JOIN box_prizes bp ON bp.box_id = pl.box_id AND bp.prize_id = pl.prize_id
      WHERE pl.box_id = p_box_id
      GROUP BY pl.prize_id, bp.quantity
      HAVING count(*) > bp.quantity
    ) overdrawn;
  IF v_prize_overdraw_count > 0 THEN
    v_issues := v_issues || format('%s prize(s) paid out more than their configured quantity', v_prize_overdraw_count);
  END IF;

  SELECT count(*) INTO v_last_one_count FROM last_one_awards WHERE box_id = p_box_id;
  IF v_last_one_count > 1 THEN
    v_issues := v_issues || format('last_one_awards has %s rows for this box (should be at most 1)', v_last_one_count);
  END IF;
  IF v_box.last_one_awarded AND v_last_one_count = 0 THEN
    v_issues := v_issues || 'boxes.last_one_awarded is true but no last_one_awards row exists'::text;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('ticketNo', ticket_no, 'prizeId', prize_id) ORDER BY ticket_no)
    INTO v_current_assignment
    FROM tickets WHERE box_id = p_box_id;
  -- Recompute the same commitment src/core/integrity.ts would, entirely in
  -- SQL, so this check has no dependency on the Node process being reachable.
  v_commitment_ok := (
    encode(digest(
      p_box_id || ' ' || v_box.assignment_salt || ' ' ||
      (SELECT string_agg(format('%s:%s', (t->>'ticketNo')::int, t->>'prizeId'), '|' ORDER BY (t->>'ticketNo')::int)
       FROM jsonb_array_elements(v_current_assignment) t),
      'sha256'), 'hex')
    = v_box.assignment_commitment
  );
  IF NOT v_commitment_ok THEN
    v_issues := v_issues || 'assignment_commitment does not match current ticket rows (possible tampering or a bug)'::text;
  END IF;

  RETURN jsonb_build_object(
    'boxId', p_box_id,
    'healthy', (array_length(v_issues, 1) IS NULL),
    'issues', to_jsonb(v_issues),
    'ticketCount', v_ticket_count,
    'consumedCount', v_consumed_count,
    'payoutCount', v_payout_count,
    'commitmentOk', v_commitment_ok
  );
END;
$$;
