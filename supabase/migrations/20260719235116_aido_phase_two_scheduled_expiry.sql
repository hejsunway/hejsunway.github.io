-- =============================================================================
-- Migration: AidoForMe Phase 2 scheduled financial expiry
--
-- The atomic single-row expiry functions already exist. This bounded service-
-- only batch makes them operational for a cron worker and isolates individual
-- failures so one inconsistent row cannot keep unrelated student credits held.
-- =============================================================================

CREATE OR REPLACE FUNCTION aido_private.expire_due_financial_state(
  p_batch_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_reservation record;
  v_lot record;
  v_selected_reservations integer := 0;
  v_expired_reservations integer := 0;
  v_selected_lots integer := 0;
  v_expired_lots integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_failure_code text;
BEGIN
  IF p_batch_limit NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Expiry batch limit must be between 1 and 2000'
      USING ERRCODE = '22023';
  END IF;

  FOR v_reservation IN
    SELECT reservation.id
    FROM public.aido_usage_reservations reservation
    WHERE reservation.status IN ('reserved', 'running')
      AND reservation.expires_at <= now()
    ORDER BY reservation.expires_at, reservation.id
    LIMIT p_batch_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_selected_reservations := v_selected_reservations + 1;
    BEGIN
      PERFORM * FROM aido_private.release_reservation(
        v_reservation.id,
        'expired'::public.aido_usage_reservation_status,
        'reservation_expired',
        'maintenance:reservation:' || v_reservation.id::text
      );
      v_expired_reservations := v_expired_reservations + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failure_code := SQLSTATE;
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'entity_type', 'reservation',
        'entity_id', v_reservation.id,
        'code', v_failure_code
      ));
    END;
  END LOOP;

  -- Reservation releases run first so lots that were previously held can be
  -- expired in the same maintenance transaction.
  FOR v_lot IN
    SELECT lot.id
    FROM public.aido_credit_lots lot
    WHERE lot.status = 'active'
      AND lot.expires_at IS NOT NULL
      AND lot.expires_at <= now()
      AND lot.reserved_credits = 0
    ORDER BY lot.expires_at, lot.id
    LIMIT p_batch_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_selected_lots := v_selected_lots + 1;
    BEGIN
      PERFORM * FROM aido_private.expire_credit_lot(
        v_lot.id,
        'maintenance:lot:' || v_lot.id::text
      );
      v_expired_lots := v_expired_lots + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failure_code := SQLSTATE;
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'entity_type', 'credit_lot',
        'entity_id', v_lot.id,
        'code', v_failure_code
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'selected_reservations', v_selected_reservations,
    'expired_reservations', v_expired_reservations,
    'selected_credit_lots', v_selected_lots,
    'expired_credit_lots', v_expired_lots,
    'failures', v_failures,
    'has_more',
      EXISTS (
        SELECT 1 FROM public.aido_usage_reservations reservation
        WHERE reservation.status IN ('reserved', 'running')
          AND reservation.expires_at <= now()
      )
      OR EXISTS (
        SELECT 1 FROM public.aido_credit_lots lot
        WHERE lot.status = 'active'
          AND lot.expires_at IS NOT NULL
          AND lot.expires_at <= now()
          AND lot.reserved_credits = 0
      )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.aido_expire_due_financial_state(
  p_batch_limit integer
)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT aido_private.expire_due_financial_state(p_batch_limit);
$$;

CREATE OR REPLACE FUNCTION public.aido_expiry_reconciliation_issues()
RETURNS TABLE (category text, entity_id text, details jsonb)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    'reservation_expiry_overdue'::text,
    reservation.id::text,
    jsonb_build_object(
      'user_id', reservation.user_id,
      'status', reservation.status,
      'maximum_credits', reservation.maximum_credits,
      'expires_at', reservation.expires_at
    )
  FROM public.aido_usage_reservations reservation
  WHERE reservation.status IN ('reserved', 'running')
    AND reservation.expires_at <= now()
  UNION ALL
  SELECT
    'credit_lot_expiry_overdue'::text,
    lot.id::text,
    jsonb_build_object(
      'user_id', lot.user_id,
      'remaining_credits', lot.remaining_credits,
      'expires_at', lot.expires_at
    )
  FROM public.aido_credit_lots lot
  WHERE lot.status = 'active'
    AND lot.expires_at IS NOT NULL
    AND lot.expires_at <= now()
    AND lot.reserved_credits = 0;
$$;

REVOKE ALL ON FUNCTION aido_private.expire_due_financial_state(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION aido_private.expire_due_financial_state(integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.aido_expire_due_financial_state(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aido_expire_due_financial_state(integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.aido_expiry_reconciliation_issues()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aido_expiry_reconciliation_issues()
  TO service_role;

NOTIFY pgrst, 'reload schema';
