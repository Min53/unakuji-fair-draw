-- unakuji-fair-draw: final-segment queue functions
--
-- Turn re-validation for the actual draw happens inside kuji_draw()
-- (002_functions.sql), not here — these functions manage who is waiting /
-- whose turn it currently is, but the draw itself is the sole source of
-- truth for "did this holder's turn really still hold at the instant of
-- drawing".

CREATE OR REPLACE FUNCTION kuji_join_queue(
  p_box_id text,
  p_holder text,
  p_request_id text,
  p_turn_ttl_seconds int,
  p_payload_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing purchase_requests%ROWTYPE;
  v_box boxes%ROWTYPE;
  v_remaining int;
  v_next_position bigint;
  v_has_active boolean;
  v_status text;
  v_turn_expires_at timestamptz;
  v_id uuid;
  v_result jsonb;
BEGIN
  IF p_turn_ttl_seconds IS NULL OR p_turn_ttl_seconds <= 0 OR p_turn_ttl_seconds > 1800 THEN
    RAISE EXCEPTION 'INVALID_INPUT: turnTtlSeconds must be between 1 and 1800';
  END IF;

  SELECT * INTO v_existing FROM purchase_requests WHERE box_id = p_box_id AND request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.payload_hash <> p_payload_hash THEN
      RAISE EXCEPTION 'REQUEST_CONFLICT: requestId % was already used with different input', p_request_id;
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_box FROM boxes WHERE id = p_box_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;
  IF v_box.status <> 'on_sale' THEN
    RAISE EXCEPTION 'BOX_NOT_ON_SALE: box % is not on sale (status=%)', p_box_id, v_box.status;
  END IF;

  SELECT count(*) INTO v_remaining FROM tickets WHERE box_id = p_box_id AND status <> 'consumed';
  IF v_box.final_queue_threshold = 0 OR v_remaining > v_box.final_queue_threshold THEN
    -- This is the fix for the join-guard gap this engine is modeled on: a
    -- box outside its final segment must reject joins outright, not just
    -- hide the "join" button in a UI a direct API call can bypass.
    RAISE EXCEPTION 'QUEUE_NOT_REQUIRED: box % is not in its final-segment queue phase (remaining=%, threshold=%)',
      p_box_id, v_remaining, v_box.final_queue_threshold;
  END IF;

  IF EXISTS (SELECT 1 FROM queue_entries WHERE box_id = p_box_id AND holder = p_holder AND status IN ('waiting','active')) THEN
    RAISE EXCEPTION 'QUEUE_ALREADY_JOINED: holder % already has an open queue entry for box %', p_holder, p_box_id;
  END IF;

  -- Expire any stale active entry for this box before deciding whether the
  -- new entry can start active immediately.
  UPDATE queue_entries SET status = 'expired', updated_at = now()
    WHERE box_id = p_box_id AND status = 'active' AND turn_expires_at <= now();

  SELECT EXISTS (SELECT 1 FROM queue_entries WHERE box_id = p_box_id AND status = 'active') INTO v_has_active;
  SELECT coalesce(max("position"), 0) + 1 INTO v_next_position FROM queue_entries WHERE box_id = p_box_id;

  IF v_has_active THEN
    v_status := 'waiting';
    v_turn_expires_at := NULL;
  ELSE
    v_status := 'active';
    v_turn_expires_at := now() + make_interval(secs => p_turn_ttl_seconds);
  END IF;

  INSERT INTO queue_entries (box_id, holder, "position", status, turn_ttl_seconds, turn_expires_at)
  VALUES (p_box_id, p_holder, v_next_position, v_status, p_turn_ttl_seconds, v_turn_expires_at)
  RETURNING id INTO v_id;

  v_result := jsonb_build_object(
    'id', v_id, 'boxId', p_box_id, 'holder', p_holder, 'position', v_next_position,
    'status', v_status, 'turnExpiresAt', to_jsonb(v_turn_expires_at)
  );

  INSERT INTO purchase_requests (box_id, request_id, action, holder, payload_hash, result)
  VALUES (p_box_id, p_request_id, 'join_queue', p_holder, p_payload_hash, v_result);

  RETURN v_result;
END;
$$;

-- Promotes the earliest 'waiting' entry (if any) for a box to 'active',
-- granting it the turn_ttl_seconds it was promised at join time. Shared by
-- kuji_leave_queue and kuji_advance_queue. Caller must already hold the box
-- lock (FOR UPDATE on boxes) — both call sites do.
CREATE OR REPLACE FUNCTION kuji_promote_next_in_queue(p_box_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_next queue_entries%ROWTYPE;
BEGIN
  SELECT * INTO v_next FROM queue_entries
    WHERE box_id = p_box_id AND status = 'waiting'
    ORDER BY "position" ASC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE queue_entries
      SET status = 'active', turn_expires_at = now() + make_interval(secs => v_next.turn_ttl_seconds), updated_at = now()
      WHERE id = v_next.id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION kuji_leave_queue(p_box_id text, p_holder text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_box boxes%ROWTYPE;
  v_entry queue_entries%ROWTYPE;
BEGIN
  SELECT * INTO v_box FROM boxes WHERE id = p_box_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;

  SELECT * INTO v_entry FROM queue_entries
    WHERE box_id = p_box_id AND holder = p_holder AND status IN ('waiting','active')
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUEUE_ENTRY_NOT_FOUND: holder % has no open queue entry for box %', p_holder, p_box_id;
  END IF;

  UPDATE queue_entries SET status = 'left', updated_at = now() WHERE id = v_entry.id;

  IF v_entry.status = 'active' THEN
    PERFORM kuji_promote_next_in_queue(p_box_id);
  END IF;

  RETURN jsonb_build_object('id', v_entry.id, 'status', 'left');
END;
$$;

CREATE OR REPLACE FUNCTION kuji_queue_status(p_box_id text, p_holder text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    (SELECT jsonb_build_object(
        'id', id, 'boxId', box_id, 'holder', holder, 'position', "position",
        'status', status, 'turnExpiresAt', to_jsonb(turn_expires_at)
      )
      FROM queue_entries
      WHERE box_id = p_box_id AND holder = p_holder AND status IN ('waiting','active')
      ORDER BY joined_at DESC LIMIT 1),
    jsonb_build_object('boxId', p_box_id, 'holder', p_holder, 'status', 'not_queued')
  );
$$;

-- Sweeps every box: expires stale active turns, then promotes the next
-- waiting entry for each box left without one. Intended to run on a short
-- interval (a few seconds) from a background worker — see README
-- "Background jobs". Not required for correctness (kuji_draw always
-- re-validates), only for keeping the queue moving promptly.
CREATE OR REPLACE FUNCTION kuji_advance_queue(p_box_id text DEFAULT NULL, p_limit int DEFAULT 1000)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_box_id text;
  v_count int := 0;
BEGIN
  FOR v_box_id IN
    SELECT DISTINCT qe.box_id FROM queue_entries qe
    JOIN boxes b ON b.id = qe.box_id
    WHERE qe.status = 'active' AND qe.turn_expires_at <= now()
      AND (p_box_id IS NULL OR qe.box_id = p_box_id)
    LIMIT p_limit
  LOOP
    PERFORM 1 FROM boxes WHERE id = v_box_id FOR UPDATE;
    UPDATE queue_entries SET status = 'expired', updated_at = now()
      WHERE box_id = v_box_id AND status = 'active' AND turn_expires_at <= now();
    PERFORM kuji_promote_next_in_queue(v_box_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
