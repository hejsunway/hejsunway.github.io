-- =============================================================================
-- Migration: AidoForMe Phase 2 cache-write token accounting
--
-- Prompt-cache writes can have a distinct provider price and are reported as
-- a distinct subset of input tokens. They must therefore be represented in
-- the immutable price snapshot and append-only usage journal. The service RPC
-- recomputes cost from canonical prices so a caller cannot omit this cost.
-- =============================================================================

ALTER TABLE public.aido_provider_prices
  ADD COLUMN cache_write_input_microusd_per_million_tokens bigint NOT NULL DEFAULT 0;

ALTER TABLE public.aido_provider_prices
  DROP CONSTRAINT aido_provider_prices_nonnegative,
  DROP CONSTRAINT aido_provider_prices_has_cost,
  ADD CONSTRAINT aido_provider_prices_nonnegative CHECK (
    input_microusd_per_million_tokens >= 0
    AND cached_input_microusd_per_million_tokens >= 0
    AND cache_write_input_microusd_per_million_tokens >= 0
    AND output_microusd_per_million_tokens >= 0
    AND tool_call_microusd >= 0
    AND search_call_microusd >= 0
  ),
  ADD CONSTRAINT aido_provider_prices_has_cost CHECK (
    input_microusd_per_million_tokens::numeric
    + cached_input_microusd_per_million_tokens::numeric
    + cache_write_input_microusd_per_million_tokens::numeric
    + output_microusd_per_million_tokens::numeric
    + tool_call_microusd::numeric
    + search_call_microusd::numeric > 0
  );

ALTER TABLE public.aido_usage_events
  ADD COLUMN cache_write_input_tokens bigint NOT NULL DEFAULT 0;

ALTER TABLE public.aido_usage_events
  DROP CONSTRAINT aido_usage_events_usage_values,
  ADD CONSTRAINT aido_usage_events_usage_values CHECK (
    attempt BETWEEN 1 AND 100
    AND input_tokens >= 0
    AND cached_input_tokens >= 0
    AND cache_write_input_tokens >= 0
    AND cached_input_tokens::numeric + cache_write_input_tokens::numeric <= input_tokens::numeric
    AND output_tokens >= 0
    AND tool_calls >= 0
    AND search_calls >= 0
    AND processed_pages >= 0
    AND latency_ms >= 0
    AND provider_cost_microusd >= 0
  );

-- The original importer predates the new price dimension. Keep its proven
-- transaction body, but place it behind a validating wrapper and an insert
-- trigger that supplies the reviewed cache-write price atomically.
ALTER FUNCTION aido_private.apply_billing_configuration(jsonb, text, uuid)
  RENAME TO apply_billing_configuration_without_cache_write;

CREATE OR REPLACE FUNCTION aido_private.set_imported_cache_write_price()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_price_map_text text;
  v_price_text text;
BEGIN
  v_price_map_text := current_setting('aido.cache_write_price_map', true);
  IF v_price_map_text IS NULL OR v_price_map_text = '' THEN
    RETURN NEW;
  END IF;

  v_price_text := (v_price_map_text::jsonb ->> NEW.id::text);
  IF v_price_text IS NULL THEN
    RAISE EXCEPTION 'Imported provider price is missing its cache-write price'
      USING ERRCODE = '22023';
  END IF;
  NEW.cache_write_input_microusd_per_million_tokens := v_price_text::bigint;
  RETURN NEW;
END;
$$;

CREATE TRIGGER aido_set_imported_cache_write_price
  BEFORE INSERT ON public.aido_provider_prices
  FOR EACH ROW EXECUTE FUNCTION aido_private.set_imported_cache_write_price();

CREATE OR REPLACE FUNCTION aido_private.apply_billing_configuration(
  p_configuration jsonb,
  p_source_sha256 text,
  p_applied_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_price_map jsonb;
  v_import_id uuid;
  v_violation record;
BEGIN
  IF jsonb_typeof(p_configuration -> 'provider_prices') <> 'array' THEN
    RAISE EXCEPTION 'Provider prices must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_configuration -> 'provider_prices') = 0
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_configuration -> 'provider_prices') AS price(value)
       WHERE jsonb_typeof(price.value -> 'cache_write_input_microusd_per_million_tokens') <> 'number'
          OR (price.value ->> 'cache_write_input_microusd_per_million_tokens') !~ '^[0-9]+$'
     ) THEN
    RAISE EXCEPTION 'Every provider price requires a non-negative integer cache-write price'
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_object_agg(
    price.value ->> 'id',
    price.value -> 'cache_write_input_microusd_per_million_tokens'
  ) INTO v_price_map
  FROM jsonb_array_elements(p_configuration -> 'provider_prices') AS price(value);

  PERFORM set_config('aido.cache_write_price_map', v_price_map::text, true);
  v_import_id := aido_private.apply_billing_configuration_without_cache_write(
    p_configuration,
    p_source_sha256,
    p_applied_by
  );

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_configuration -> 'provider_prices') AS supplied(value)
    LEFT JOIN public.aido_provider_prices price
      ON price.id = (supplied.value ->> 'id')::uuid
    WHERE price.id IS NULL
       OR price.cache_write_input_microusd_per_million_tokens
          <> (supplied.value ->> 'cache_write_input_microusd_per_million_tokens')::bigint
  ) THEN
    RAISE EXCEPTION 'Imported cache-write prices do not match the reviewed configuration'
      USING ERRCODE = '22023';
  END IF;

  SELECT rate.feature_key, price.provider, price.model INTO v_violation
  FROM public.aido_provider_routes route
  JOIN public.aido_feature_rate_cards rate ON rate.id = route.feature_rate_card_id
  JOIN public.aido_provider_prices price ON price.id = route.provider_price_id
  WHERE rate.billing_config_id = (p_configuration -> 'billing_config' ->> 'id')::uuid
    AND route.approved
    AND (
      (
        rate.max_input_tokens::bigint
        * GREATEST(
          price.input_microusd_per_million_tokens,
          price.cached_input_microusd_per_million_tokens,
          price.cache_write_input_microusd_per_million_tokens
        ) + 999999
      ) / 1000000
      + (rate.max_output_tokens::bigint * price.output_microusd_per_million_tokens + 999999) / 1000000
      + rate.max_tool_calls::bigint * price.tool_call_microusd
      + rate.max_search_calls::bigint * price.search_call_microusd
    ) > rate.max_provider_cost_microusd
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Approved route %/% cache-write exposure exceeds the ceiling for %',
      v_violation.provider, v_violation.model, v_violation.feature_key
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_import_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.aido_apply_billing_configuration(
  p_configuration jsonb,
  p_source_sha256 text,
  p_applied_by uuid
)
RETURNS uuid
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT aido_private.apply_billing_configuration(
    p_configuration, p_source_sha256, p_applied_by
  );
$$;

REVOKE ALL ON FUNCTION aido_private.apply_billing_configuration_without_cache_write(jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION aido_private.set_imported_cache_write_price()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION aido_private.apply_billing_configuration(jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION aido_private.apply_billing_configuration(jsonb, text, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.aido_apply_billing_configuration(jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aido_apply_billing_configuration(jsonb, text, uuid)
  TO service_role;

-- Replace the old usage RPC rather than leaving an overload that could omit
-- cache-write usage. The private implementation recomputes the exact cost from
-- the reservation's immutable price snapshot before appending the event.
DROP FUNCTION public.aido_record_usage_event(
  uuid, text, text, text, bigint, bigint, bigint, integer, integer, integer,
  integer, bigint, public.aido_usage_outcome, boolean, text
);
DROP FUNCTION aido_private.record_usage_event(
  uuid, text, text, text, bigint, bigint, bigint, integer, integer, integer,
  integer, bigint, public.aido_usage_outcome, boolean, text
);

CREATE OR REPLACE FUNCTION aido_private.record_usage_event(
  p_authorization_id uuid,
  p_idempotency_key text,
  p_provider_request_id text,
  p_prompt_version text,
  p_input_tokens bigint,
  p_cached_input_tokens bigint,
  p_cache_write_input_tokens bigint,
  p_output_tokens bigint,
  p_tool_calls integer,
  p_search_calls integer,
  p_processed_pages integer,
  p_latency_ms integer,
  p_provider_cost_microusd bigint,
  p_outcome public.aido_usage_outcome,
  p_billable_to_student boolean,
  p_failure_category text
)
RETURNS public.aido_usage_events
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_authorization_ref public.aido_provider_call_authorizations%ROWTYPE;
  v_authorization public.aido_provider_call_authorizations%ROWTYPE;
  v_reservation public.aido_usage_reservations%ROWTYPE;
  v_rate public.aido_feature_rate_cards%ROWTYPE;
  v_route public.aido_provider_routes%ROWTYPE;
  v_price public.aido_provider_prices%ROWTYPE;
  v_existing public.aido_usage_events%ROWTYPE;
  v_usage public.aido_usage_events%ROWTYPE;
  v_totals record;
  v_expected_cost bigint;
BEGIN
  SELECT auth_call.* INTO v_authorization_ref
  FROM public.aido_provider_call_authorizations auth_call
  WHERE auth_call.id = p_authorization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Provider authorization not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT reservation.* INTO v_reservation
  FROM public.aido_usage_reservations reservation
  WHERE reservation.id = v_authorization_ref.reservation_id
  FOR UPDATE;

  SELECT auth_call.* INTO v_authorization
  FROM public.aido_provider_call_authorizations auth_call
  WHERE auth_call.id = p_authorization_id
  FOR UPDATE;

  SELECT event.* INTO v_existing
  FROM public.aido_usage_events event
  WHERE event.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.reservation_id <> v_reservation.id
       OR NOT EXISTS (
         SELECT 1
         FROM public.aido_provider_call_authorizations auth_call
         WHERE auth_call.id = p_authorization_id
           AND auth_call.usage_event_id = v_existing.id
       )
       OR v_existing.provider_request_id IS DISTINCT FROM p_provider_request_id
       OR v_existing.prompt_version <> p_prompt_version
       OR v_existing.input_tokens <> p_input_tokens
       OR v_existing.cached_input_tokens <> p_cached_input_tokens
       OR v_existing.cache_write_input_tokens <> p_cache_write_input_tokens
       OR v_existing.output_tokens <> p_output_tokens
       OR v_existing.tool_calls <> p_tool_calls
       OR v_existing.search_calls <> p_search_calls
       OR v_existing.processed_pages <> p_processed_pages
       OR v_existing.latency_ms <> p_latency_ms
       OR v_existing.provider_cost_microusd <> p_provider_cost_microusd
       OR v_existing.outcome <> p_outcome
       OR v_existing.billable_to_student <> (
         CASE WHEN p_outcome = 'succeeded' THEN p_billable_to_student ELSE false END
       )
       OR v_existing.failure_category IS DISTINCT FROM p_failure_category THEN
      RAISE EXCEPTION 'Usage key reused with different provider facts' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing;
  END IF;

  IF v_authorization.status <> 'authorized'
     OR v_authorization.expires_at <= now()
     OR v_reservation.status <> 'running' THEN
    RAISE EXCEPTION 'Provider call authorization is not active' USING ERRCODE = '55000';
  END IF;

  IF p_provider_request_id IS NOT NULL THEN
    SELECT event.* INTO v_existing
    FROM public.aido_usage_events event
    JOIN public.aido_provider_routes route ON route.id = event.provider_route_id
    JOIN public.aido_provider_prices price ON price.id = route.provider_price_id
    WHERE price.provider = (
      SELECT provider_price.provider
      FROM public.aido_provider_routes provider_route
      JOIN public.aido_provider_prices provider_price ON provider_price.id = provider_route.provider_price_id
      WHERE provider_route.id = v_reservation.provider_route_id
    )
      AND event.provider_request_id = p_provider_request_id;
    IF FOUND THEN
      IF v_existing.reservation_id <> v_reservation.id
         OR NOT EXISTS (
           SELECT 1
           FROM public.aido_provider_call_authorizations auth_call
           WHERE auth_call.id = p_authorization_id
             AND auth_call.usage_event_id = v_existing.id
         )
         OR v_existing.idempotency_key <> p_idempotency_key
         OR v_existing.prompt_version <> p_prompt_version
         OR v_existing.input_tokens <> p_input_tokens
         OR v_existing.cached_input_tokens <> p_cached_input_tokens
         OR v_existing.cache_write_input_tokens <> p_cache_write_input_tokens
         OR v_existing.output_tokens <> p_output_tokens
         OR v_existing.tool_calls <> p_tool_calls
         OR v_existing.search_calls <> p_search_calls
         OR v_existing.processed_pages <> p_processed_pages
         OR v_existing.latency_ms <> p_latency_ms
         OR v_existing.provider_cost_microusd <> p_provider_cost_microusd
         OR v_existing.outcome <> p_outcome
         OR v_existing.billable_to_student <> (
           CASE WHEN p_outcome = 'succeeded' THEN p_billable_to_student ELSE false END
         )
         OR v_existing.failure_category IS DISTINCT FROM p_failure_category THEN
        RAISE EXCEPTION 'Provider request ID reused with different provider facts' USING ERRCODE = '23505';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  IF p_input_tokens < 0
     OR p_cached_input_tokens < 0
     OR p_cache_write_input_tokens < 0
     OR p_cached_input_tokens::numeric + p_cache_write_input_tokens::numeric > p_input_tokens::numeric
     OR p_output_tokens < 0
     OR p_tool_calls < 0
     OR p_search_calls < 0
     OR p_processed_pages < 0
     OR p_latency_ms < 0
     OR p_provider_cost_microusd < 0
     OR (p_outcome = 'succeeded' AND p_failure_category IS NOT NULL)
     OR (p_outcome <> 'succeeded' AND p_billable_to_student) THEN
    RAISE EXCEPTION 'Invalid provider usage values' USING ERRCODE = '22023';
  END IF;

  SELECT rate.* INTO v_rate
  FROM public.aido_feature_rate_cards rate
  WHERE rate.id = v_reservation.feature_rate_card_id;
  SELECT route.* INTO v_route
  FROM public.aido_provider_routes route
  WHERE route.id = v_reservation.provider_route_id;
  SELECT price.* INTO v_price
  FROM public.aido_provider_prices price
  WHERE price.id = v_route.provider_price_id;

  v_expected_cost :=
    ceil(
      (p_input_tokens - p_cached_input_tokens - p_cache_write_input_tokens)::numeric
      * v_price.input_microusd_per_million_tokens::numeric / 1000000
    )::bigint
    + ceil(
      p_cached_input_tokens::numeric
      * v_price.cached_input_microusd_per_million_tokens::numeric / 1000000
    )::bigint
    + ceil(
      p_cache_write_input_tokens::numeric
      * v_price.cache_write_input_microusd_per_million_tokens::numeric / 1000000
    )::bigint
    + ceil(
      p_output_tokens::numeric
      * v_price.output_microusd_per_million_tokens::numeric / 1000000
    )::bigint
    + p_tool_calls::bigint * v_price.tool_call_microusd
    + p_search_calls::bigint * v_price.search_call_microusd;

  IF p_provider_cost_microusd <> v_expected_cost THEN
    RAISE EXCEPTION 'Provider cost does not match canonical usage pricing'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    COALESCE(sum(event.input_tokens), 0) AS input_tokens,
    COALESCE(sum(event.output_tokens), 0) AS output_tokens,
    COALESCE(sum(event.tool_calls), 0) AS tool_calls,
    COALESCE(sum(event.search_calls), 0) AS search_calls,
    COALESCE(sum(event.processed_pages), 0) AS pages,
    COALESCE(sum(event.provider_cost_microusd), 0) AS cost
  INTO v_totals
  FROM public.aido_usage_events event
  WHERE event.reservation_id = v_reservation.id;

  IF p_outcome = 'succeeded' AND (
    p_provider_cost_microusd > v_authorization.estimated_cost_microusd
    OR v_totals.input_tokens + p_input_tokens > v_rate.max_input_tokens
    OR v_totals.output_tokens + p_output_tokens > v_rate.max_output_tokens
    OR v_totals.tool_calls + p_tool_calls > v_rate.max_tool_calls
    OR v_totals.search_calls + p_search_calls > v_rate.max_search_calls
    OR v_totals.pages + p_processed_pages > v_rate.max_pages
    OR v_totals.cost + p_provider_cost_microusd > v_reservation.provider_budget_microusd
  ) THEN
    RAISE EXCEPTION 'Successful provider usage exceeds its authorization' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.aido_usage_events (
    reservation_id,
    user_id,
    provider_route_id,
    provider,
    model,
    provider_request_id,
    idempotency_key,
    attempt,
    prompt_version,
    input_tokens,
    cached_input_tokens,
    cache_write_input_tokens,
    output_tokens,
    tool_calls,
    search_calls,
    processed_pages,
    latency_ms,
    provider_cost_microusd,
    outcome,
    billable_to_student,
    failure_category
  ) VALUES (
    v_reservation.id,
    v_reservation.user_id,
    v_reservation.provider_route_id,
    v_price.provider,
    v_price.model,
    p_provider_request_id,
    p_idempotency_key,
    v_authorization.attempt,
    p_prompt_version,
    p_input_tokens,
    p_cached_input_tokens,
    p_cache_write_input_tokens,
    p_output_tokens,
    p_tool_calls,
    p_search_calls,
    p_processed_pages,
    p_latency_ms,
    p_provider_cost_microusd,
    p_outcome,
    CASE WHEN p_outcome = 'succeeded' THEN p_billable_to_student ELSE false END,
    p_failure_category
  )
  RETURNING * INTO v_usage;

  UPDATE public.aido_provider_call_authorizations
  SET status = 'consumed',
      actual_cost_microusd = p_provider_cost_microusd,
      usage_event_id = v_usage.id,
      consumed_at = now()
  WHERE id = p_authorization_id;

  UPDATE public.aido_usage_reservations
  SET actual_provider_cost_microusd = actual_provider_cost_microusd + p_provider_cost_microusd
  WHERE id = v_reservation.id;

  RETURN v_usage;
END;
$$;

CREATE OR REPLACE FUNCTION public.aido_record_usage_event(
  p_authorization_id uuid,
  p_idempotency_key text,
  p_provider_request_id text,
  p_prompt_version text,
  p_input_tokens bigint,
  p_cached_input_tokens bigint,
  p_cache_write_input_tokens bigint,
  p_output_tokens bigint,
  p_tool_calls integer,
  p_search_calls integer,
  p_processed_pages integer,
  p_latency_ms integer,
  p_provider_cost_microusd bigint,
  p_outcome public.aido_usage_outcome,
  p_billable_to_student boolean,
  p_failure_category text
)
RETURNS public.aido_usage_events
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT * FROM aido_private.record_usage_event(
    p_authorization_id,
    p_idempotency_key,
    p_provider_request_id,
    p_prompt_version,
    p_input_tokens,
    p_cached_input_tokens,
    p_cache_write_input_tokens,
    p_output_tokens,
    p_tool_calls,
    p_search_calls,
    p_processed_pages,
    p_latency_ms,
    p_provider_cost_microusd,
    p_outcome,
    p_billable_to_student,
    p_failure_category
  );
$$;

REVOKE ALL ON FUNCTION aido_private.record_usage_event(
  uuid, text, text, text, bigint, bigint, bigint, bigint, integer, integer,
  integer, integer, bigint, public.aido_usage_outcome, boolean, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION aido_private.record_usage_event(
  uuid, text, text, text, bigint, bigint, bigint, bigint, integer, integer,
  integer, integer, bigint, public.aido_usage_outcome, boolean, text
) TO service_role;
REVOKE ALL ON FUNCTION public.aido_record_usage_event(
  uuid, text, text, text, bigint, bigint, bigint, bigint, integer, integer,
  integer, integer, bigint, public.aido_usage_outcome, boolean, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aido_record_usage_event(
  uuid, text, text, text, bigint, bigint, bigint, bigint, integer, integer,
  integer, integer, bigint, public.aido_usage_outcome, boolean, text
) TO service_role;

NOTIFY pgrst, 'reload schema';
