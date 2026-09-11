-- unakuji-fair-draw: core functions (box creation, draw, reservations, entitlements)
--
-- Error convention: every RAISE EXCEPTION message starts with
-- "ERROR_CODE: human readable text". The Node adapter (src/adapters/postgres)
-- parses the prefix and rethrows a KujiError with that `code`. Do not change
-- an existing prefix without updating src/adapters/postgres/pgError.ts to match.
--
-- Locking strategy: kuji_draw, kuji_reserve_tickets and kuji_join_queue all
-- take `SELECT ... FOR UPDATE` on the box row first. That serializes every
-- state-changing call for a given box through one lock, which is the
-- simplest correct way to make "check remaining count / queue turn / ticket
-- availability, then act" race-free — see README "Concurrency model" for why
-- this reference implementation chooses correctness-by-serialization over a
-- finer-grained (and much harder to prove correct) locking scheme.

CREATE OR REPLACE FUNCTION kuji_public_box(p_box_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_box boxes%ROWTYPE;
  v_remaining int;
  v_remaining_by_prize jsonb;
  v_available_ticket_nos int[];
BEGIN
  SELECT * INTO v_box FROM boxes WHERE id = p_box_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;

  SELECT array_agg(ticket_no ORDER BY ticket_no) INTO v_available_ticket_nos
    FROM tickets WHERE box_id = p_box_id AND status <> 'consumed';
  v_remaining := coalesce(array_length(v_available_ticket_nos, 1), 0);

  SELECT jsonb_agg(jsonb_build_object('prizeId', bp.prize_id, 'quantity', coalesce(r.qty, 0)) ORDER BY bp.prize_id)
    INTO v_remaining_by_prize
    FROM box_prizes bp
    LEFT JOIN (
      SELECT prize_id, count(*) AS qty FROM tickets
        WHERE box_id = p_box_id AND status <> 'consumed'
        GROUP BY prize_id
    ) r ON r.prize_id = bp.prize_id
    WHERE bp.box_id = p_box_id;

  RETURN jsonb_build_object(
    'id', v_box.id,
    'status', v_box.status,
    'totalTickets', v_box.total_tickets,
    'availableTicketNos', to_jsonb(coalesce(v_available_ticket_nos, ARRAY[]::int[])),
    'remainingByPrize', coalesce(v_remaining_by_prize, '[]'::jsonb),
    'remaining', v_remaining,
    'lastOneAwarded', v_box.last_one_awarded,
    'inFinalQueuePhase', (v_box.status = 'on_sale' AND v_box.final_queue_threshold > 0 AND v_remaining <= v_box.final_queue_threshold)
  );
END;
$$;

CREATE OR REPLACE FUNCTION kuji_audit(p_box_id text, p_action text, p_actor text, p_reason text, p_before jsonb, p_after jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO audit_log (box_id, action, actor, reason, before, after)
  VALUES (p_box_id, p_action, p_actor, p_reason, p_before, p_after);
$$;

-- ============================================================================
-- Box creation. The random assignment itself is computed by the TypeScript
-- caller (src/rng.ts, using crypto.randomInt) and passed in as p_assignment
-- — this function only validates and persists it. No randomness happens in
-- SQL; see README "Fairness" for why that separation is deliberate.
-- ============================================================================
CREATE OR REPLACE FUNCTION kuji_create_box(
  p_id text,
  p_prizes jsonb,               -- [{"id": text, "quantity": int}, ...]
  p_assignment jsonb,           -- [{"ticketNo": int, "prizeId": text}, ...]
  p_commitment text,
  p_salt text,
  p_last_one_prize_id text,
  p_sale_opens_at timestamptz,
  p_final_queue_threshold int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_total int;
  v_prize_total int;
  v_status text;
BEGIN
  IF EXISTS (SELECT 1 FROM boxes WHERE id = p_id) THEN
    RAISE EXCEPTION 'BOX_ALREADY_EXISTS: box % already exists', p_id;
  END IF;

  SELECT coalesce(sum((p->>'quantity')::int), 0) INTO v_prize_total FROM jsonb_array_elements(p_prizes) p;
  SELECT count(*) INTO v_total FROM jsonb_array_elements(p_assignment);
  IF v_total <> v_prize_total OR v_total = 0 THEN
    RAISE EXCEPTION 'INVALID_INPUT: assignment length (%) does not match total prize quantity (%)', v_total, v_prize_total;
  END IF;

  IF p_last_one_prize_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_prizes) p WHERE p->>'id' = p_last_one_prize_id
  ) THEN
    RAISE EXCEPTION 'INVALID_INPUT: lastOnePrizeId % is not one of this box''s prizes', p_last_one_prize_id;
  END IF;

  v_status := CASE WHEN p_sale_opens_at IS NOT NULL THEN 'upcoming' ELSE 'preparing' END;

  INSERT INTO boxes (id, status, total_tickets, last_one_prize_id, final_queue_threshold, assignment_commitment, assignment_salt, sale_opens_at)
  VALUES (p_id, v_status, v_total, p_last_one_prize_id, coalesce(p_final_queue_threshold, 0), p_commitment, p_salt, p_sale_opens_at);

  INSERT INTO box_prizes (box_id, prize_id, quantity)
  SELECT p_id, p->>'id', (p->>'quantity')::int FROM jsonb_array_elements(p_prizes) p;

  INSERT INTO tickets (box_id, ticket_no, prize_id, status)
  SELECT p_id, (a->>'ticketNo')::int, a->>'prizeId', 'available' FROM jsonb_array_elements(p_assignment) a;

  PERFORM kuji_audit(p_id, 'create_box', NULL, NULL, NULL, kuji_public_box(p_id));

  RETURN kuji_public_box(p_id);
END;
$$;

-- ============================================================================
-- The central atomic operation. See file header for locking strategy and
-- README "Concurrency model" / "Recovery" for the idempotency contract.
-- ============================================================================
CREATE OR REPLACE FUNCTION kuji_draw(
  p_box_id text,
  p_holder text,
  p_request_id text,
  p_ticket_nos int[],
  p_entitlement_ids uuid[],
  p_payload_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing purchase_requests%ROWTYPE;
  v_box boxes%ROWTYPE;
  v_ticket_count int;
  v_available_count int;
  v_remaining_before int;
  v_remaining_after int;
  v_in_queue_phase boolean;
  v_ticket_no int;
  v_entitlement_id uuid;
  v_entitlement entitlements%ROWTYPE;
  v_idx int;
  v_items jsonb := '[]'::jsonb;
  v_prize_id text;
  v_last_one_awarded_now boolean := false;
  v_last_one_prize_id text := NULL;
  v_result jsonb;
BEGIN
  IF p_ticket_nos IS NULL OR array_length(p_ticket_nos, 1) IS NULL THEN
    RAISE EXCEPTION 'INVALID_INPUT: ticketNos must be a non-empty array';
  END IF;
  IF p_entitlement_ids IS NOT NULL AND array_length(p_entitlement_ids, 1) IS NOT NULL
     AND array_length(p_entitlement_ids, 1) <> array_length(p_ticket_nos, 1) THEN
    RAISE EXCEPTION 'ENTITLEMENT_TICKET_MISMATCH: entitlementIds length (%) must match ticketNos length (%)',
      array_length(p_entitlement_ids, 1), array_length(p_ticket_nos, 1);
  END IF;

  -- Idempotency short-circuit: a plain (uncontended) read is fine here
  -- because the box lock below still protects the write path; two
  -- concurrent first-attempts with the same requestId will both pass this
  -- check but only one will win the box lock and the INSERT at the end
  -- (PRIMARY KEY (box_id, request_id)) makes the loser's insert fail, which
  -- surfaces as an ordinary transaction error to that caller — safe to retry.
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

  v_ticket_count := array_length(p_ticket_nos, 1);
  SELECT count(*) INTO v_available_count FROM tickets WHERE box_id = p_box_id AND ticket_no = ANY(p_ticket_nos);
  IF v_available_count <> v_ticket_count THEN
    RAISE EXCEPTION 'TICKET_NOT_FOUND: one or more of tickets % do not exist in box %', p_ticket_nos, p_box_id;
  END IF;

  SELECT count(*) INTO v_remaining_before FROM tickets WHERE box_id = p_box_id AND status <> 'consumed';

  -- Final-segment queue: re-check the holder's turn atomically, inside the
  -- same box-locked transaction that is about to consume tickets, so a turn
  -- can never expire (or be raced) between "check" and "act".
  v_in_queue_phase := v_box.final_queue_threshold > 0 AND v_remaining_before <= v_box.final_queue_threshold;
  IF v_in_queue_phase THEN
    PERFORM 1 FROM queue_entries
      WHERE box_id = p_box_id AND holder = p_holder AND status = 'active' AND turn_expires_at > now()
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'QUEUE_TURN_REQUIRED: holder % does not hold an active queue turn for box % (remaining=%, threshold=%)',
        p_holder, p_box_id, v_remaining_before, v_box.final_queue_threshold;
    END IF;
  END IF;

  -- Entitlements (optional — omit p_entitlement_ids entirely for
  -- integrations that police draw eligibility themselves; see README
  -- "Entitlements are opt-in").
  IF p_entitlement_ids IS NOT NULL AND array_length(p_entitlement_ids, 1) IS NOT NULL THEN
    FOR v_idx IN 1 .. array_length(p_entitlement_ids, 1) LOOP
      v_entitlement_id := p_entitlement_ids[v_idx];
      SELECT * INTO v_entitlement FROM entitlements WHERE id = v_entitlement_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ENTITLEMENT_NOT_FOUND: entitlement % not found', v_entitlement_id;
      END IF;
      IF v_entitlement.box_id <> p_box_id THEN
        RAISE EXCEPTION 'ENTITLEMENT_INVALID: entitlement % does not belong to box %', v_entitlement_id, p_box_id;
      END IF;
      IF v_entitlement.holder <> p_holder THEN
        RAISE EXCEPTION 'FORBIDDEN: entitlement % does not belong to holder %', v_entitlement_id, p_holder;
      END IF;
      IF v_entitlement.status = 'void' THEN
        RAISE EXCEPTION 'ENTITLEMENT_INVALID: entitlement % has been voided', v_entitlement_id;
      END IF;
      IF v_entitlement.status = 'consumed' THEN
        RAISE EXCEPTION 'ENTITLEMENT_ALREADY_CONSUMED: entitlement % has already been used', v_entitlement_id;
      END IF;
      IF v_entitlement.expires_at IS NOT NULL AND v_entitlement.expires_at <= now() THEN
        RAISE EXCEPTION 'ENTITLEMENT_INVALID: entitlement % has expired', v_entitlement_id;
      END IF;
    END LOOP;
  END IF;

  -- Ticket availability (per-ticket, so the error names the offending ticket).
  FOREACH v_ticket_no IN ARRAY p_ticket_nos LOOP
    PERFORM 1 FROM tickets WHERE box_id = p_box_id AND ticket_no = v_ticket_no FOR UPDATE;
    IF EXISTS (SELECT 1 FROM tickets WHERE box_id = p_box_id AND ticket_no = v_ticket_no AND status = 'consumed') THEN
      RAISE EXCEPTION 'TICKET_UNAVAILABLE: ticket % has already been drawn', v_ticket_no;
    END IF;
    IF EXISTS (
      SELECT 1 FROM tickets
      WHERE box_id = p_box_id AND ticket_no = v_ticket_no AND status = 'reserved'
        AND reserved_by <> p_holder AND reserved_until > now()
    ) THEN
      RAISE EXCEPTION 'TICKET_UNAVAILABLE: ticket % is held by another holder', v_ticket_no;
    END IF;
  END LOOP;

  -- Consume tickets, build the result items, write the payout ledger.
  FOR v_idx IN 1 .. v_ticket_count LOOP
    v_ticket_no := p_ticket_nos[v_idx];
    UPDATE tickets
      SET status = 'consumed', reserved_by = NULL, reserved_until = NULL, consumed_at = now()
      WHERE box_id = p_box_id AND ticket_no = v_ticket_no
      RETURNING prize_id INTO v_prize_id;

    v_entitlement_id := NULL;
    IF p_entitlement_ids IS NOT NULL AND array_length(p_entitlement_ids, 1) IS NOT NULL THEN
      v_entitlement_id := p_entitlement_ids[v_idx];
    END IF;

    INSERT INTO payout_ledger (box_id, ticket_no, prize_id, holder, entitlement_id, request_id)
    VALUES (p_box_id, v_ticket_no, v_prize_id, p_holder, v_entitlement_id, p_request_id);

    v_items := v_items || jsonb_build_array(jsonb_build_object('ticketNo', v_ticket_no, 'prizeId', v_prize_id));
  END LOOP;

  -- Single-use entitlements are consumed exactly once, tied to the ticket
  -- they paid for; unlimited ("master") entitlements stay active forever —
  -- see 001_tables.sql comment on the entitlements table.
  IF p_entitlement_ids IS NOT NULL AND array_length(p_entitlement_ids, 1) IS NOT NULL THEN
    FOR v_idx IN 1 .. array_length(p_entitlement_ids, 1) LOOP
      UPDATE entitlements
        SET status = 'consumed', consumed_at = now(), consumed_ticket_no = p_ticket_nos[v_idx]
        WHERE id = p_entitlement_ids[v_idx] AND kind = 'single_use';
    END LOOP;
  END IF;

  SELECT count(*) INTO v_remaining_after FROM tickets WHERE box_id = p_box_id AND status <> 'consumed';

  -- Last-one: the request that drains the box to zero remaining normal
  -- tickets wins it, exactly once (PRIMARY KEY(box_id) on last_one_awards
  -- backs this up at the schema level even if this check had a bug).
  IF v_box.last_one_prize_id IS NOT NULL AND NOT v_box.last_one_awarded AND v_remaining_after = 0 THEN
    INSERT INTO last_one_awards (box_id, ticket_no, prize_id, holder, request_id)
    VALUES (p_box_id, p_ticket_nos[v_ticket_count], v_box.last_one_prize_id, p_holder, p_request_id)
    ON CONFLICT (box_id) DO NOTHING;
    IF FOUND THEN
      v_last_one_awarded_now := true;
      v_last_one_prize_id := v_box.last_one_prize_id;
      UPDATE boxes SET last_one_awarded = true WHERE id = p_box_id;
    END IF;
  END IF;

  UPDATE boxes
    SET status = CASE WHEN v_remaining_after = 0 THEN 'sold_out' ELSE status END,
        updated_at = now()
    WHERE id = p_box_id;

  v_result := jsonb_build_object(
    'boxId', p_box_id,
    'requestId', p_request_id,
    'items', v_items,
    'lastOnePrizeId', v_last_one_prize_id,
    'lastOneAwarded', (v_box.last_one_awarded OR v_last_one_awarded_now),
    'remaining', v_remaining_after
  );

  INSERT INTO purchase_requests (box_id, request_id, action, holder, payload_hash, result)
  VALUES (p_box_id, p_request_id, 'draw', p_holder, p_payload_hash, v_result);

  RETURN v_result;
END;
$$;

-- ============================================================================
-- Reservations
-- ============================================================================
CREATE OR REPLACE FUNCTION kuji_reserve_tickets(
  p_box_id text,
  p_holder text,
  p_request_id text,
  p_ticket_nos int[],
  p_ttl_ms bigint,
  p_payload_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing purchase_requests%ROWTYPE;
  v_box boxes%ROWTYPE;
  v_ticket_no int;
  v_reserved_until timestamptz;
  v_result jsonb;
BEGIN
  IF p_ticket_nos IS NULL OR array_length(p_ticket_nos, 1) IS NULL THEN
    RAISE EXCEPTION 'INVALID_INPUT: ticketNos must be a non-empty array';
  END IF;
  -- Millisecond precision end-to-end (matches ReserveTicketsInput.ttlMs in
  -- the core/memory-adapter contract) — deliberately NOT rounded up to whole
  -- seconds, so a short test/integration hold behaves the same here as it
  -- does against the memory adapter.
  IF p_ttl_ms IS NULL OR p_ttl_ms <= 0 OR p_ttl_ms > 1800000 THEN
    RAISE EXCEPTION 'INVALID_INPUT: ttlMs must be between 1 and 1800000';
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

  IF (SELECT count(*) FROM tickets WHERE box_id = p_box_id AND ticket_no = ANY(p_ticket_nos)) <> array_length(p_ticket_nos, 1) THEN
    RAISE EXCEPTION 'TICKET_NOT_FOUND: one or more of tickets % do not exist in box %', p_ticket_nos, p_box_id;
  END IF;

  FOREACH v_ticket_no IN ARRAY p_ticket_nos LOOP
    PERFORM 1 FROM tickets WHERE box_id = p_box_id AND ticket_no = v_ticket_no FOR UPDATE;
    IF EXISTS (SELECT 1 FROM tickets WHERE box_id = p_box_id AND ticket_no = v_ticket_no AND status = 'consumed') THEN
      RAISE EXCEPTION 'TICKET_UNAVAILABLE: ticket % has already been drawn', v_ticket_no;
    END IF;
    IF EXISTS (
      SELECT 1 FROM tickets
      WHERE box_id = p_box_id AND ticket_no = v_ticket_no AND status = 'reserved'
        AND reserved_by <> p_holder AND reserved_until > now()
    ) THEN
      RAISE EXCEPTION 'RESERVATION_CONFLICT: ticket % is already held by another holder', v_ticket_no;
    END IF;
  END LOOP;

  v_reserved_until := now() + make_interval(secs => p_ttl_ms / 1000.0);

  UPDATE tickets SET status = 'reserved', reserved_by = p_holder, reserved_until = v_reserved_until
    WHERE box_id = p_box_id AND ticket_no = ANY(p_ticket_nos);

  v_result := jsonb_build_object(
    'boxId', p_box_id,
    'requestId', p_request_id,
    'holder', p_holder,
    'ticketNos', to_jsonb(p_ticket_nos),
    'reservedUntil', to_jsonb(v_reserved_until)
  );

  INSERT INTO purchase_requests (box_id, request_id, action, holder, payload_hash, result)
  VALUES (p_box_id, p_request_id, 'reserve', p_holder, p_payload_hash, v_result);

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION kuji_release_reservation(p_box_id text, p_holder text, p_ticket_nos int[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE tickets
    SET status = 'available', reserved_by = NULL, reserved_until = NULL
    WHERE box_id = p_box_id AND ticket_no = ANY(p_ticket_nos)
      AND status = 'reserved' AND reserved_by = p_holder;
$$;

-- Sweeps expired holds back to 'available'. Safe to run on any schedule
-- (e.g. every few seconds from a worker) — see README "Background jobs".
CREATE OR REPLACE FUNCTION kuji_expire_reservations(p_box_id text DEFAULT NULL, p_limit int DEFAULT 5000)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count int;
BEGIN
  WITH expired AS (
    SELECT box_id, ticket_no FROM tickets
    WHERE status = 'reserved' AND reserved_until <= now()
      AND (p_box_id IS NULL OR box_id = p_box_id)
    LIMIT p_limit
    FOR UPDATE
  )
  UPDATE tickets t SET status = 'available', reserved_by = NULL, reserved_until = NULL
    FROM expired e WHERE t.box_id = e.box_id AND t.ticket_no = e.ticket_no;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ============================================================================
-- Entitlements
-- ============================================================================
CREATE OR REPLACE FUNCTION kuji_issue_entitlement(
  p_box_id text,
  p_holder text,
  p_kind text,
  p_source text,
  p_external_ref text,
  p_expires_at timestamptz,
  p_max_active_per_holder int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
  v_active_count int;
BEGIN
  IF p_kind NOT IN ('single_use', 'unlimited') THEN
    RAISE EXCEPTION 'INVALID_INPUT: kind must be single_use or unlimited';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM boxes WHERE id = p_box_id) THEN
    RAISE EXCEPTION 'BOX_NOT_FOUND: box % does not exist', p_box_id;
  END IF;

  IF p_max_active_per_holder IS NOT NULL THEN
    -- Advisory lock scoped to (box, holder) so two concurrent issuance calls
    -- for the same holder can't both pass the limit check before either commits.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_box_id || ':' || p_holder, 0));
    SELECT count(*) INTO v_active_count FROM entitlements
      WHERE box_id = p_box_id AND holder = p_holder AND status = 'active';
    IF v_active_count >= p_max_active_per_holder THEN
      RAISE EXCEPTION 'ENTITLEMENT_LIMIT_EXCEEDED: holder % already has % active entitlements for box % (limit %)',
        p_holder, v_active_count, p_box_id, p_max_active_per_holder;
    END IF;
  END IF;

  INSERT INTO entitlements (box_id, holder, kind, source, external_ref, expires_at)
  VALUES (p_box_id, p_holder, p_kind, p_source, p_external_ref, p_expires_at)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id, 'boxId', p_box_id, 'holder', p_holder, 'kind', p_kind,
    'status', 'active', 'source', p_source, 'externalRef', p_external_ref, 'expiresAt', to_jsonb(p_expires_at)
  );
END;
$$;

CREATE OR REPLACE FUNCTION kuji_cancel_entitlement(p_entitlement_id uuid, p_actor text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_entitlement entitlements%ROWTYPE;
BEGIN
  SELECT * INTO v_entitlement FROM entitlements WHERE id = p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ENTITLEMENT_NOT_FOUND: entitlement % not found', p_entitlement_id;
  END IF;
  IF v_entitlement.status = 'consumed' THEN
    -- Deliberate: canceling an already-consumed entitlement would be
    -- "undo a completed draw", which this engine never does. See README
    -- "What this engine deliberately does not do".
    RAISE EXCEPTION 'ENTITLEMENT_ALREADY_CONSUMED: entitlement % has already been used and cannot be canceled', p_entitlement_id;
  END IF;
  IF v_entitlement.status = 'void' THEN
    RETURN jsonb_build_object('id', v_entitlement.id, 'status', 'void');
  END IF;

  UPDATE entitlements SET status = 'void', voided_at = now(), void_reason = p_reason WHERE id = p_entitlement_id;
  PERFORM kuji_audit(v_entitlement.box_id, 'cancel_entitlement', p_actor, p_reason,
    to_jsonb(v_entitlement), jsonb_build_object('id', v_entitlement.id, 'status', 'void'));

  RETURN jsonb_build_object('id', v_entitlement.id, 'status', 'void');
END;
$$;
