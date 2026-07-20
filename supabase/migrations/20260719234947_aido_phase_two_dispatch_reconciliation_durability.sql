-- =============================================================================
-- Migration: preserve ambiguous provider dispatches after credit release
--
-- Releasing or expiring a reservation returns student credits and changes any
-- pending provider authorization to released. That must not erase evidence of
-- an already-dispatched request whose provider usage was never recorded.
-- =============================================================================

DROP INDEX public.idx_aido_provider_call_authorizations_unresolved_dispatch;
CREATE INDEX idx_aido_provider_call_authorizations_unresolved_dispatch
  ON public.aido_provider_call_authorizations (expires_at)
  WHERE dispatched_at IS NOT NULL
    AND usage_event_id IS NULL
    AND status IN ('authorized', 'released');

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
      'authorization_status', auth_call.status,
      'estimated_cost_microusd', auth_call.estimated_cost_microusd,
      'dispatched_at', auth_call.dispatched_at,
      'expires_at', auth_call.expires_at,
      'released_at', auth_call.released_at
    )
  FROM public.aido_provider_call_authorizations auth_call
  JOIN public.aido_usage_reservations reservation
    ON reservation.id = auth_call.reservation_id
  JOIN public.aido_provider_routes route
    ON route.id = reservation.provider_route_id
  JOIN public.aido_provider_prices price
    ON price.id = route.provider_price_id
  WHERE auth_call.status IN ('authorized', 'released')
    AND auth_call.dispatched_at IS NOT NULL
    AND auth_call.usage_event_id IS NULL
    AND auth_call.expires_at <= now();
$$;

REVOKE ALL ON FUNCTION public.aido_provider_dispatch_reconciliation_issues()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aido_provider_dispatch_reconciliation_issues()
  TO service_role;

NOTIFY pgrst, 'reload schema';
