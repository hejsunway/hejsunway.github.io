-- =============================================================================
-- Migration: AidoForMe Phase 2 provider dispatch hardening
--
-- A provider authorization is a financial ceiling, but it did not previously
-- prove whether a worker had crossed the irreversible network boundary. A
-- worker crash after sending a request could therefore retry the same call and
-- incur a second provider charge. The one-way dispatched_at marker closes that
-- gap: only the worker that changes NULL to a timestamp may send the request.
-- Ambiguous dispatched calls remain visible to reconciliation until usage is
-- recorded or the authorization is explicitly released.
-- =============================================================================

ALTER TABLE public.aido_provider_call_authorizations
  ADD COLUMN dispatched_at timestamptz;

-- Existing consumed rows necessarily crossed the provider boundary. This
-- backfill makes the stronger state constraint safe on databases that already
-- processed Phase 2 traffic before this migration was installed.
UPDATE public.aido_provider_call_authorizations
SET dispatched_at = COALESCE(consumed_at, created_at)
WHERE status = 'consumed'
  AND dispatched_at IS NULL;

ALTER TABLE public.aido_provider_call_authorizations
  DROP CONSTRAINT aido_provider_call_authorizations_status;

ALTER TABLE public.aido_provider_call_authorizations
  ADD CONSTRAINT aido_provider_call_authorizations_status CHECK (
    (status = 'authorized'
      AND actual_cost_microusd IS NULL
      AND usage_event_id IS NULL
      AND consumed_at IS NULL
      AND released_at IS NULL)
    OR (status = 'consumed'
      AND actual_cost_microusd IS NOT NULL
      AND usage_event_id IS NOT NULL
      AND consumed_at IS NOT NULL
      AND released_at IS NULL
      AND dispatched_at IS NOT NULL)
    OR (status = 'released'
      AND actual_cost_microusd IS NULL
      AND usage_event_id IS NULL
      AND consumed_at IS NULL
      AND released_at IS NOT NULL)
  );

CREATE INDEX idx_aido_provider_call_authorizations_unresolved_dispatch
  ON public.aido_provider_call_authorizations (expires_at)
  WHERE status = 'authorized' AND dispatched_at IS NOT NULL;

CREATE OR REPLACE FUNCTION aido_private.mark_provider_call_dispatched(
  p_authorization_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_authorization public.aido_provider_call_authorizations%ROWTYPE;
BEGIN
  SELECT auth_call.* INTO v_authorization
  FROM public.aido_provider_call_authorizations auth_call
  WHERE auth_call.id = p_authorization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Provider authorization not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_authorization.status <> 'authorized' OR v_authorization.expires_at <= now() THEN
    RAISE EXCEPTION 'Provider call authorization is not active' USING ERRCODE = '55000';
  END IF;
  IF v_authorization.dispatched_at IS NOT NULL THEN
    RETURN false;
  END IF;

  UPDATE public.aido_provider_call_authorizations
  SET dispatched_at = now()
  WHERE id = p_authorization_id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.aido_mark_provider_call_dispatched(
  p_authorization_id uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT aido_private.mark_provider_call_dispatched(p_authorization_id);
$$;

CREATE OR REPLACE FUNCTION public.aido_provider_dispatch_reconciliation_issues()
RETURNS TABLE (category text, entity_id text, details jsonb)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    'provider_dispatch_unresolved'::text,
    auth_call.id::text,
    jsonb_build_object(
      'reservation_id', auth_call.reservation_id,
      'provider', price.provider,
      'model', price.model,
      'attempt', auth_call.attempt,
      'estimated_cost_microusd', auth_call.estimated_cost_microusd,
      'dispatched_at', auth_call.dispatched_at,
      'expires_at', auth_call.expires_at
    )
  FROM public.aido_provider_call_authorizations auth_call
  JOIN public.aido_usage_reservations reservation
    ON reservation.id = auth_call.reservation_id
  JOIN public.aido_provider_routes route
    ON route.id = reservation.provider_route_id
  JOIN public.aido_provider_prices price
    ON price.id = route.provider_price_id
  WHERE auth_call.status = 'authorized'
    AND auth_call.dispatched_at IS NOT NULL
    AND auth_call.expires_at <= now();
$$;

REVOKE ALL ON FUNCTION aido_private.mark_provider_call_dispatched(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION aido_private.mark_provider_call_dispatched(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.aido_mark_provider_call_dispatched(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aido_mark_provider_call_dispatched(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.aido_provider_dispatch_reconciliation_issues()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aido_provider_dispatch_reconciliation_issues()
  TO service_role;

NOTIFY pgrst, 'reload schema';
