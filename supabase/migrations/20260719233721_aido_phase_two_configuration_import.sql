-- =============================================================================
-- Migration: AidoForMe Phase 2 atomic billing-configuration import
--
-- Configuration is supplied by an operator as reviewed JSON. This migration
-- deliberately contains no products, prices, model names, rates, or balances.
-- The service-only RPC applies one complete payload transactionally and rejects
-- any configuration whose worst approved provider route breaches the minimum
-- job margin budget or whose credit product cannot fund its promised credits.
-- =============================================================================

CREATE TABLE public.aido_billing_configuration_imports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_sha256         text NOT NULL UNIQUE,
  configuration_label   text NOT NULL,
  target_environment    text NOT NULL,
  applied_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  applied_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_billing_configuration_import_hash CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT aido_billing_configuration_import_label CHECK (
    char_length(btrim(configuration_label)) BETWEEN 3 AND 160
  ),
  CONSTRAINT aido_billing_configuration_import_environment CHECK (
    target_environment IN ('staging', 'production')
  )
);

CREATE INDEX idx_aido_billing_configuration_imports_applied_by
  ON public.aido_billing_configuration_imports (applied_by)
  WHERE applied_by IS NOT NULL;

CREATE TRIGGER aido_immutable_billing_configuration_imports
  BEFORE UPDATE OR DELETE ON public.aido_billing_configuration_imports
  FOR EACH ROW EXECUTE FUNCTION public.aido_reject_historical_mutation();

ALTER TABLE public.aido_billing_configuration_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.aido_billing_configuration_imports
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.aido_billing_configuration_imports TO service_role;

CREATE OR REPLACE FUNCTION aido_private.apply_billing_configuration(
  p_configuration jsonb,
  p_source_sha256 text,
  p_applied_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_import_id uuid;
  v_billing_id uuid;
  v_config jsonb;
  v_row jsonb;
  v_violation record;
BEGIN
  IF jsonb_typeof(p_configuration) <> 'object'
     OR p_source_sha256 !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_configuration -> 'billing_config') <> 'object'
     OR jsonb_typeof(p_configuration -> 'provider_prices') <> 'array'
     OR jsonb_typeof(p_configuration -> 'feature_rate_cards') <> 'array'
     OR jsonb_typeof(p_configuration -> 'provider_routes') <> 'array'
     OR jsonb_typeof(p_configuration -> 'credit_products') <> 'array'
     OR jsonb_typeof(p_configuration -> 'system_controls') <> 'array'
     OR jsonb_array_length(p_configuration -> 'provider_prices') = 0
     OR jsonb_array_length(p_configuration -> 'feature_rate_cards') = 0
     OR jsonb_array_length(p_configuration -> 'provider_routes') = 0
     OR jsonb_array_length(p_configuration -> 'credit_products') = 0
     OR jsonb_array_length(p_configuration -> 'system_controls') = 0 THEN
    RAISE EXCEPTION 'Invalid billing configuration envelope' USING ERRCODE = '22023';
  END IF;

  SELECT import.id INTO v_import_id
  FROM public.aido_billing_configuration_imports import
  WHERE import.source_sha256 = p_source_sha256;
  IF FOUND THEN
    RETURN v_import_id;
  END IF;

  INSERT INTO public.aido_billing_configuration_imports (
    source_sha256, configuration_label, target_environment, applied_by
  ) VALUES (
    p_source_sha256,
    p_configuration ->> 'configuration_label',
    p_configuration ->> 'target_environment',
    p_applied_by
  ) RETURNING id INTO v_import_id;

  v_config := p_configuration -> 'billing_config';
  INSERT INTO public.aido_billing_config_versions (
    id, version, currency, credits_per_retail_myr,
    net_revenue_sen_per_1000_credits, provider_cost_target_bps,
    quote_safety_multiplier_bps, payment_risk_reserve_bps,
    budget_myr_sen_per_usd, minimum_topup_sen,
    effective_from, effective_to, created_by
  ) VALUES (
    (v_config ->> 'id')::uuid,
    (v_config ->> 'version')::integer,
    'MYR',
    (v_config ->> 'credits_per_retail_myr')::bigint,
    (v_config ->> 'net_revenue_sen_per_1000_credits')::bigint,
    (v_config ->> 'provider_cost_target_bps')::integer,
    (v_config ->> 'quote_safety_multiplier_bps')::integer,
    (v_config ->> 'payment_risk_reserve_bps')::integer,
    (v_config ->> 'budget_myr_sen_per_usd')::bigint,
    (v_config ->> 'minimum_topup_sen')::bigint,
    (v_config ->> 'effective_from')::timestamptz,
    NULLIF(v_config ->> 'effective_to', '')::timestamptz,
    p_applied_by
  ) RETURNING id INTO v_billing_id;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_configuration -> 'provider_prices')
  LOOP
    IF v_row ->> 'provider' NOT IN ('openai', 'deepseek', 'minimax') THEN
      RAISE EXCEPTION 'Provider is not supported by the fixed-endpoint gateway' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.aido_provider_prices (
      id, provider, model, version, currency,
      input_microusd_per_million_tokens,
      cached_input_microusd_per_million_tokens,
      output_microusd_per_million_tokens,
      tool_call_microusd, search_call_microusd,
      effective_from, effective_to, source_reference, created_by
    ) VALUES (
      (v_row ->> 'id')::uuid,
      v_row ->> 'provider',
      v_row ->> 'model',
      (v_row ->> 'version')::integer,
      'USD',
      (v_row ->> 'input_microusd_per_million_tokens')::bigint,
      (v_row ->> 'cached_input_microusd_per_million_tokens')::bigint,
      (v_row ->> 'output_microusd_per_million_tokens')::bigint,
      (v_row ->> 'tool_call_microusd')::bigint,
      (v_row ->> 'search_call_microusd')::bigint,
      (v_row ->> 'effective_from')::timestamptz,
      NULLIF(v_row ->> 'effective_to', '')::timestamptz,
      v_row ->> 'source_reference',
      p_applied_by
    );
  END LOOP;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_configuration -> 'feature_rate_cards')
  LOOP
    IF (v_row ->> 'billing_config_id')::uuid <> v_billing_id THEN
      RAISE EXCEPTION 'Every rate card must reference the imported billing configuration' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.aido_feature_rate_cards (
      id, feature_key, version, billing_config_id,
      base_credits, credits_per_1000_input_tokens,
      credits_per_1000_output_tokens, credits_per_page,
      credits_per_source, credits_per_search,
      minimum_credits, maximum_credits, max_provider_cost_microusd,
      max_input_tokens, max_output_tokens, max_tool_calls,
      max_search_calls, max_pages, max_sources, max_retries,
      timeout_ms, daily_user_credit_cap, concurrent_job_cap,
      effective_from, effective_to, created_by
    ) VALUES (
      (v_row ->> 'id')::uuid,
      v_row ->> 'feature_key',
      (v_row ->> 'version')::integer,
      (v_row ->> 'billing_config_id')::uuid,
      (v_row ->> 'base_credits')::bigint,
      (v_row ->> 'credits_per_1000_input_tokens')::bigint,
      (v_row ->> 'credits_per_1000_output_tokens')::bigint,
      (v_row ->> 'credits_per_page')::bigint,
      (v_row ->> 'credits_per_source')::bigint,
      (v_row ->> 'credits_per_search')::bigint,
      (v_row ->> 'minimum_credits')::bigint,
      (v_row ->> 'maximum_credits')::bigint,
      (v_row ->> 'max_provider_cost_microusd')::bigint,
      (v_row ->> 'max_input_tokens')::integer,
      (v_row ->> 'max_output_tokens')::integer,
      (v_row ->> 'max_tool_calls')::integer,
      (v_row ->> 'max_search_calls')::integer,
      (v_row ->> 'max_pages')::integer,
      (v_row ->> 'max_sources')::integer,
      (v_row ->> 'max_retries')::integer,
      (v_row ->> 'timeout_ms')::integer,
      (v_row ->> 'daily_user_credit_cap')::bigint,
      (v_row ->> 'concurrent_job_cap')::integer,
      (v_row ->> 'effective_from')::timestamptz,
      NULLIF(v_row ->> 'effective_to', '')::timestamptz,
      p_applied_by
    );
  END LOOP;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_configuration -> 'provider_routes')
  LOOP
    INSERT INTO public.aido_provider_routes (
      id, feature_rate_card_id, provider_price_id, priority,
      evaluation_reference, privacy_policy_version, approved,
      effective_from, effective_to, created_by
    ) VALUES (
      (v_row ->> 'id')::uuid,
      (v_row ->> 'feature_rate_card_id')::uuid,
      (v_row ->> 'provider_price_id')::uuid,
      (v_row ->> 'priority')::smallint,
      v_row ->> 'evaluation_reference',
      v_row ->> 'privacy_policy_version',
      (v_row ->> 'approved')::boolean,
      (v_row ->> 'effective_from')::timestamptz,
      NULLIF(v_row ->> 'effective_to', '')::timestamptz,
      p_applied_by
    );
  END LOOP;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_configuration -> 'credit_products')
  LOOP
    INSERT INTO public.aido_credit_products (
      id, product_key, version, kind, stripe_product_id, stripe_price_id,
      currency, amount_sen, credit_grant, expires_after_days,
      effective_from, effective_to, created_by
    ) VALUES (
      (v_row ->> 'id')::uuid,
      v_row ->> 'product_key',
      (v_row ->> 'version')::integer,
      (v_row ->> 'kind')::public.aido_credit_product_kind,
      v_row ->> 'stripe_product_id',
      v_row ->> 'stripe_price_id',
      'MYR',
      (v_row ->> 'amount_sen')::bigint,
      (v_row ->> 'credit_grant')::bigint,
      NULLIF(v_row ->> 'expires_after_days', '')::integer,
      (v_row ->> 'effective_from')::timestamptz,
      NULLIF(v_row ->> 'effective_to', '')::timestamptz,
      p_applied_by
    );
  END LOOP;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_configuration -> 'system_controls')
  LOOP
    INSERT INTO public.aido_system_controls (
      scope_type, scope_key, is_enabled,
      daily_provider_budget_microusd, max_concurrent_calls, updated_by
    ) VALUES (
      (v_row ->> 'scope_type')::public.aido_control_scope,
      v_row ->> 'scope_key',
      (v_row ->> 'is_enabled')::boolean,
      (v_row ->> 'daily_provider_budget_microusd')::bigint,
      (v_row ->> 'max_concurrent_calls')::integer,
      p_applied_by
    )
    ON CONFLICT (scope_type, scope_key) DO UPDATE
      SET is_enabled = EXCLUDED.is_enabled,
          daily_provider_budget_microusd = EXCLUDED.daily_provider_budget_microusd,
          max_concurrent_calls = EXCLUDED.max_concurrent_calls,
          updated_by = EXCLUDED.updated_by;
  END LOOP;

  -- Conservative invariant: even the full approved provider ceiling must fit
  -- inside the target provider budget funded by the minimum job charge.
  SELECT rate.feature_key INTO v_violation
  FROM public.aido_feature_rate_cards rate
  JOIN public.aido_billing_config_versions config ON config.id = rate.billing_config_id
  WHERE rate.billing_config_id = v_billing_id
    AND rate.max_provider_cost_microusd >
      (
        (
          ((rate.minimum_credits * config.net_revenue_sen_per_1000_credits + 999) / 1000)
          * config.provider_cost_target_bps / 10000
        ) * 1000000 / config.budget_myr_sen_per_usd
      )
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Rate card % violates the minimum-charge provider margin', v_violation.feature_key
      USING ERRCODE = 'P0001';
  END IF;

  -- At every approved route's maximum token/tool/search usage, the provider
  -- price must remain inside the rate card's declared provider ceiling.
  SELECT rate.feature_key, price.provider, price.model INTO v_violation
  FROM public.aido_provider_routes route
  JOIN public.aido_feature_rate_cards rate ON rate.id = route.feature_rate_card_id
  JOIN public.aido_provider_prices price ON price.id = route.provider_price_id
  WHERE rate.billing_config_id = v_billing_id
    AND route.approved
    AND (
      (
        rate.max_input_tokens::bigint
        * GREATEST(
          price.input_microusd_per_million_tokens,
          price.cached_input_microusd_per_million_tokens
        ) + 999999
      ) / 1000000
      + (rate.max_output_tokens::bigint * price.output_microusd_per_million_tokens + 999999) / 1000000
      + rate.max_tool_calls::bigint * price.tool_call_microusd
      + rate.max_search_calls::bigint * price.search_call_microusd
    ) > rate.max_provider_cost_microusd
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Approved route %/% exceeds the ceiling for %',
      v_violation.provider, v_violation.model, v_violation.feature_key
      USING ERRCODE = 'P0001';
  END IF;

  -- Credit promises must fit both the retail conversion and the conservative
  -- net revenue left after the payment-risk reserve.
  SELECT product.product_key INTO v_violation
  FROM public.aido_credit_products product
  JOIN public.aido_billing_config_versions config ON config.id = v_billing_id
  WHERE product.id IN (
      SELECT (value ->> 'id')::uuid
      FROM jsonb_array_elements(p_configuration -> 'credit_products')
    )
    AND (
      product.credit_grant > product.amount_sen * config.credits_per_retail_myr / 100
      OR (
        product.amount_sen * (10000 - config.payment_risk_reserve_bps) / 10000
      ) < (
        product.credit_grant * config.net_revenue_sen_per_1000_credits + 999
      ) / 1000
      OR (product.kind = 'topup' AND product.amount_sen < config.minimum_topup_sen)
    )
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Credit product % is not fully funded by its price', v_violation.product_key
      USING ERRCODE = 'P0001';
  END IF;

  -- Every approved route needs all four fail-closed control scopes. Controls
  -- may intentionally be disabled; absence is never treated as permission.
  SELECT rate.feature_key, price.provider, price.model INTO v_violation
  FROM public.aido_provider_routes route
  JOIN public.aido_feature_rate_cards rate ON rate.id = route.feature_rate_card_id
  JOIN public.aido_provider_prices price ON price.id = route.provider_price_id
  WHERE rate.billing_config_id = v_billing_id
    AND route.approved
    AND NOT (
      EXISTS (SELECT 1 FROM public.aido_system_controls WHERE scope_type = 'global' AND scope_key = '*')
      AND EXISTS (SELECT 1 FROM public.aido_system_controls WHERE scope_type = 'feature' AND scope_key = rate.feature_key)
      AND EXISTS (SELECT 1 FROM public.aido_system_controls WHERE scope_type = 'provider' AND scope_key = price.provider)
      AND EXISTS (SELECT 1 FROM public.aido_system_controls WHERE scope_type = 'model' AND scope_key = price.provider || '/' || price.model)
    )
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Approved route %/% is missing a required control scope',
      v_violation.provider, v_violation.model
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

REVOKE ALL ON FUNCTION aido_private.apply_billing_configuration(jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION aido_private.apply_billing_configuration(jsonb, text, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.aido_apply_billing_configuration(jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aido_apply_billing_configuration(jsonb, text, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
