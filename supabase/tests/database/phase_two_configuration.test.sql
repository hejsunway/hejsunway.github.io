BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(20);

SELECT has_table(
  'public',
  'aido_billing_configuration_imports',
  'billing configuration imports are journaled'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.aido_billing_configuration_imports'::regclass),
  'configuration import journal has RLS enabled'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.aido_billing_configuration_imports', 'SELECT'),
  'authenticated users cannot inspect configuration imports'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'public.aido_apply_billing_configuration(jsonb,text,uuid)', 'EXECUTE'
  ),
  'authenticated users cannot import billing configuration'
);
SELECT ok(
  has_function_privilege(
    'service_role', 'public.aido_apply_billing_configuration(jsonb,text,uuid)', 'EXECUTE'
  ),
  'service role can invoke the atomic configuration importer'
);

CREATE TEMP TABLE phase2_configuration_fixture (payload jsonb NOT NULL);
GRANT SELECT ON phase2_configuration_fixture TO service_role;

INSERT INTO phase2_configuration_fixture (payload)
VALUES (jsonb_build_object(
  'configuration_label', 'Phase 2 configuration import test',
  'target_environment', 'staging',
  'billing_config', jsonb_build_object(
    'id', '50000000-0000-4000-8000-000000000001',
    'version', 1,
    'credits_per_retail_myr', 10,
    'net_revenue_sen_per_1000_credits', 9000,
    'provider_cost_target_bps', 3000,
    'quote_safety_multiplier_bps', 12500,
    'payment_risk_reserve_bps', 500,
    'budget_myr_sen_per_usd', 450,
    'minimum_topup_sen', 500,
    'effective_from', '2026-07-20T00:00:00.000Z',
    'effective_to', NULL
  ),
  'provider_prices', jsonb_build_array(jsonb_build_object(
    'id', '51000000-0000-4000-8000-000000000001',
    'provider', 'openai',
    'model', 'provider-test-model',
    'version', 1,
    'input_microusd_per_million_tokens', 1000000,
    'cached_input_microusd_per_million_tokens', 100000,
    'cache_write_input_microusd_per_million_tokens', 1250000,
    'output_microusd_per_million_tokens', 2000000,
    'tool_call_microusd', 0,
    'search_call_microusd', 0,
    'effective_from', '2026-07-20T00:00:00.000Z',
    'effective_to', NULL,
    'source_reference', 'database test price source'
  )),
  'feature_rate_cards', jsonb_build_array(jsonb_build_object(
    'id', '52000000-0000-4000-8000-000000000001',
    'feature_key', 'assignment.autopilot',
    'version', 1,
    'billing_config_id', '50000000-0000-4000-8000-000000000001',
    'base_credits', 100,
    'credits_per_1000_input_tokens', 10,
    'credits_per_1000_output_tokens', 20,
    'credits_per_page', 0,
    'credits_per_source', 0,
    'credits_per_search', 0,
    'minimum_credits', 100,
    'maximum_credits', 200,
    'max_provider_cost_microusd', 500000,
    'max_input_tokens', 1000,
    'max_output_tokens', 1000,
    'max_tool_calls', 0,
    'max_search_calls', 0,
    'max_pages', 0,
    'max_sources', 0,
    'max_retries', 1,
    'timeout_ms', 120000,
    'daily_user_credit_cap', 1000,
    'concurrent_job_cap', 2,
    'effective_from', '2026-07-20T00:00:00.000Z',
    'effective_to', NULL
  )),
  'provider_routes', jsonb_build_array(jsonb_build_object(
    'id', '53000000-0000-4000-8000-000000000001',
    'feature_rate_card_id', '52000000-0000-4000-8000-000000000001',
    'provider_price_id', '51000000-0000-4000-8000-000000000001',
    'priority', 1,
    'evaluation_reference', 'database test evaluation',
    'privacy_policy_version', 'database-test-policy',
    'approved', true,
    'effective_from', '2026-07-20T00:00:00.000Z',
    'effective_to', NULL
  )),
  'credit_products', jsonb_build_array(jsonb_build_object(
    'id', '54000000-0000-4000-8000-000000000001',
    'product_key', 'topup.configuration-test',
    'version', 1,
    'kind', 'topup',
    'stripe_product_id', 'prod_configurationtest',
    'stripe_price_id', 'price_configurationtest',
    'amount_sen', 1000,
    'credit_grant', 100,
    'expires_after_days', 365,
    'effective_from', '2026-07-20T00:00:00.000Z',
    'effective_to', NULL
  )),
  'system_controls', jsonb_build_array(
    jsonb_build_object(
      'scope_type', 'global', 'scope_key', '*', 'is_enabled', false,
      'daily_provider_budget_microusd', 1000000, 'max_concurrent_calls', 10
    ),
    jsonb_build_object(
      'scope_type', 'feature', 'scope_key', 'assignment.autopilot', 'is_enabled', false,
      'daily_provider_budget_microusd', 1000000, 'max_concurrent_calls', 5
    ),
    jsonb_build_object(
      'scope_type', 'provider', 'scope_key', 'openai', 'is_enabled', false,
      'daily_provider_budget_microusd', 1000000, 'max_concurrent_calls', 5
    ),
    jsonb_build_object(
      'scope_type', 'model', 'scope_key', 'openai/provider-test-model', 'is_enabled', false,
      'daily_provider_budget_microusd', 1000000, 'max_concurrent_calls', 5
    )
  )
));

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$SELECT public.aido_apply_billing_configuration(
    (SELECT payload FROM phase2_configuration_fixture)
      #- '{provider_prices,0,cache_write_input_microusd_per_million_tokens}',
    repeat('d', 64),
    NULL
  )$$,
  '22023', NULL,
  'a provider price without explicit cache-write pricing is rejected'
);
SELECT throws_ok(
  $$SELECT public.aido_apply_billing_configuration(
    jsonb_set(
      (SELECT payload FROM phase2_configuration_fixture),
      '{feature_rate_cards,0,max_provider_cost_microusd}',
      '700000'::jsonb
    ),
    repeat('b', 64),
    NULL
  )$$,
  'P0001', NULL,
  'an unprofitable rate card is rejected'
);
SELECT is(
  (SELECT count(*) FROM public.aido_billing_configuration_imports),
  0::bigint,
  'a rejected configuration leaves no partial import journal'
);
SELECT lives_ok(
  $$SELECT public.aido_apply_billing_configuration(
    (SELECT payload FROM phase2_configuration_fixture), repeat('a', 64), NULL
  )$$,
  'a fully funded configuration applies atomically'
);
SELECT is((SELECT count(*) FROM public.aido_billing_configuration_imports), 1::bigint, 'one import is journaled');
SELECT is((SELECT count(*) FROM public.aido_billing_config_versions), 1::bigint, 'one billing version is applied');
SELECT is((SELECT count(*) FROM public.aido_provider_prices), 1::bigint, 'one provider price is applied');
SELECT is(
  (SELECT cache_write_input_microusd_per_million_tokens FROM public.aido_provider_prices),
  1250000::bigint,
  'the reviewed cache-write price is imported atomically'
);
SELECT is((SELECT count(*) FROM public.aido_feature_rate_cards), 1::bigint, 'one feature rate is applied');
SELECT is((SELECT count(*) FROM public.aido_provider_routes), 1::bigint, 'one approved route is applied');
SELECT is((SELECT count(*) FROM public.aido_credit_products), 1::bigint, 'one credit product is applied');
SELECT is((SELECT count(*) FROM public.aido_system_controls), 4::bigint, 'all four fail-closed controls are applied');
SELECT lives_ok(
  $$SELECT public.aido_apply_billing_configuration(
    (SELECT payload FROM phase2_configuration_fixture), repeat('a', 64), NULL
  )$$,
  'reapplying the identical source digest is idempotent'
);
SELECT is(
  (SELECT count(*) FROM public.aido_billing_configuration_imports),
  1::bigint,
  'idempotent import creates no duplicate financial configuration'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000999","role":"authenticated"}',
  true
);
SELECT throws_ok(
  $$SELECT public.aido_apply_billing_configuration(
    (SELECT payload FROM phase2_configuration_fixture), repeat('c', 64), NULL
  )$$,
  '42501', NULL,
  'browser-authenticated users cannot import or change financial configuration'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
