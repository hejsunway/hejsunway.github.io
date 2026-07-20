BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(80);

-- Structural and privilege boundary.
SELECT has_table('public', 'aido_credit_wallets', 'credit wallets exist');
SELECT has_table('public', 'aido_credit_lots', 'credit lots exist');
SELECT has_table('public', 'aido_credit_ledger', 'append-only credit ledger exists');
SELECT has_table('public', 'aido_usage_reservations', 'usage reservations exist');
SELECT has_table('public', 'aido_payment_events', 'verified payment event journal exists');
SELECT has_table('public', 'aido_provider_call_authorizations', 'provider-call authorizations exist');
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.aido_credit_wallets'::regclass),
  'wallets have RLS enabled'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.aido_credit_ledger'::regclass),
  'ledger has RLS enabled'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.aido_credit_wallets', 'SELECT'),
  'anonymous users have no wallet grant'
);
SELECT ok(
  has_table_privilege('authenticated', 'public.aido_credit_wallets', 'SELECT'),
  'authenticated users can read their own wallet through RLS'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.aido_credit_wallets', 'UPDATE'),
  'authenticated users cannot mutate wallets'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.aido_reserve_credits(uuid,uuid,text,uuid,uuid,text,text,bigint,bigint,bigint,timestamp with time zone)',
    'EXECUTE'
  ),
  'authenticated users cannot execute credit reservation'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.aido_process_verified_purchase_event(text,text,aido_payment_event_kind,boolean,text,text,text,text,bigint,bigint,text)',
    'EXECUTE'
  ),
  'authenticated users cannot submit verified Stripe facts'
);
SELECT ok(
  NOT has_schema_privilege('authenticated', 'aido_private', 'USAGE'),
  'authenticated users cannot access the private financial schema'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.aido_reserve_credits(uuid,uuid,text,uuid,uuid,text,text,bigint,bigint,bigint,timestamp with time zone)',
    'EXECUTE'
  ),
  'service role can execute the trusted reservation wrapper'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.aido_mark_provider_call_dispatched(uuid)',
    'EXECUTE'
  ),
  'authenticated users cannot mark a provider call as dispatched'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.aido_mark_provider_call_dispatched(uuid)',
    'EXECUTE'
  ),
  'service role can cross the provider dispatch boundary'
);

INSERT INTO auth.users (id, email, is_sso_user, is_anonymous)
VALUES
  ('00000000-0000-4000-8000-000000000201', 'phase2-owner@example.test', false, false),
  ('00000000-0000-4000-8000-000000000202', 'phase2-other@example.test', false, false);

INSERT INTO public.aido_product_memberships (user_id, status, role)
VALUES
  ('00000000-0000-4000-8000-000000000201', 'active', 'student'),
  ('00000000-0000-4000-8000-000000000202', 'active', 'student');

INSERT INTO public.aido_billing_config_versions (
  id, version, credits_per_retail_myr, net_revenue_sen_per_1000_credits,
  provider_cost_target_bps, quote_safety_multiplier_bps,
  payment_risk_reserve_bps, budget_myr_sen_per_usd,
  minimum_topup_sen, effective_from
) VALUES (
  '20000000-0000-4000-8000-000000000001', 1, 10, 10000,
  3000, 12500, 500, 450, 500, now() - interval '1 hour'
);

INSERT INTO public.aido_provider_prices (
  id, provider, model, version,
  input_microusd_per_million_tokens,
  cached_input_microusd_per_million_tokens,
  output_microusd_per_million_tokens,
  effective_from, source_reference
) VALUES (
  '21000000-0000-4000-8000-000000000001', 'openai', 'gpt-test', 1,
  1000000, 100000, 2000000,
  now() - interval '1 hour', 'phase-two-test-rate-source'
);

INSERT INTO public.aido_feature_rate_cards (
  id, feature_key, version, billing_config_id,
  base_credits, credits_per_1000_input_tokens, credits_per_1000_output_tokens,
  minimum_credits, maximum_credits, max_provider_cost_microusd,
  max_input_tokens, max_output_tokens, max_tool_calls, max_search_calls,
  max_pages, max_sources, max_retries, timeout_ms,
  daily_user_credit_cap, concurrent_job_cap, effective_from
) VALUES (
  '22000000-0000-4000-8000-000000000001', 'assignment.autopilot', 1,
  '20000000-0000-4000-8000-000000000001',
  10, 2, 4, 10, 100, 5000,
  10000, 10000, 4, 4, 20, 20, 2, 120000,
  1000, 5, now() - interval '1 hour'
);

INSERT INTO public.aido_provider_routes (
  id, feature_rate_card_id, provider_price_id, priority,
  evaluation_reference, privacy_policy_version, approved, effective_from
) VALUES (
  '23000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001',
  1, 'phase-two-evaluation', 'test-privacy-v1', true, now() - interval '1 hour'
);

INSERT INTO public.aido_credit_products (
  id, product_key, version, kind, stripe_product_id, stripe_price_id,
  amount_sen, credit_grant, expires_after_days, effective_from
) VALUES (
  '24000000-0000-4000-8000-000000000001',
  'topup.phase2', 1, 'topup', 'prod_phase2test', 'price_phase2test',
  1000, 100, 365, now() - interval '1 hour'
);

INSERT INTO public.aido_system_controls (
  scope_type, scope_key, is_enabled, daily_provider_budget_microusd, max_concurrent_calls
) VALUES
  ('global', '*', true, 100000, 10),
  ('feature', 'assignment.autopilot', true, 100000, 10),
  ('provider', 'openai', true, 100000, 10),
  ('model', 'openai/gpt-test', true, 100000, 10);

INSERT INTO public.aido_payment_customers (user_id, stripe_customer_id)
VALUES
  ('00000000-0000-4000-8000-000000000201', 'cus_phase2owner'),
  ('00000000-0000-4000-8000-000000000202', 'cus_phase2other');

SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$SELECT * FROM public.aido_process_verified_purchase_event(
    'evt_phase2purchaseone', 'checkout.session.completed', 'purchase', false,
    'cs_phase2purchaseone', 'cus_phase2owner', 'price_phase2test', 'MYR',
    1000, 950, repeat('a', 64)
  )$$,
  'a verified purchase atomically grants credits'
);
SELECT is(
  (SELECT available_credits FROM public.aido_credit_wallets
   WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  100::bigint,
  'purchase credits reach the wallet'
);
SELECT is(
  (SELECT count(*) FROM public.aido_payment_events WHERE stripe_event_id = 'evt_phase2purchaseone' AND status = 'processed'),
  1::bigint,
  'purchase event is journaled and processed once'
);
SELECT is(
  (SELECT count(*) FROM public.aido_credit_lots WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  1::bigint,
  'purchase creates one credit lot'
);
SELECT lives_ok(
  $$SELECT * FROM public.aido_process_verified_purchase_event(
    'evt_phase2purchaseone', 'checkout.session.completed', 'purchase', false,
    'cs_phase2purchaseone', 'cus_phase2owner', 'price_phase2test', 'MYR',
    1000, 950, repeat('a', 64)
  )$$,
  'duplicate verified purchase is idempotent'
);
SELECT is(
  (SELECT count(*) FROM public.aido_payment_events WHERE stripe_event_id = 'evt_phase2purchaseone'),
  1::bigint,
  'duplicate delivery leaves one payment event'
);
SELECT is(
  (SELECT count(*) FROM public.aido_credit_ledger WHERE entry_type = 'grant' AND user_id = '00000000-0000-4000-8000-000000000201'),
  1::bigint,
  'duplicate delivery leaves one grant ledger entry'
);
SELECT throws_ok(
  $$SELECT * FROM public.aido_process_verified_purchase_event(
    'evt_phase2purchaseone', 'checkout.session.completed', 'purchase', false,
    'cs_phase2purchaseone', 'cus_phase2owner', 'price_phase2test', 'MYR',
    1000, 900, repeat('a', 64)
  )$$,
  '23505', NULL,
  'purchase event ID cannot be reused with changed payment facts'
);

SELECT lives_ok(
  $$SELECT * FROM public.aido_reserve_credits(
    '00000000-0000-4000-8000-000000000201', NULL,
    'assignment.autopilot',
    '22000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000001',
    'phase2-job-success', 'phase2-reserve-success',
    60, 80, 1000, now() + interval '1 hour'
  )$$,
  'credits are reserved before provider work'
);
SELECT is(
  (SELECT available_credits FROM public.aido_credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  20::bigint,
  'reservation removes the maximum from available credits'
);
SELECT is(
  (SELECT reserved_credits FROM public.aido_credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  80::bigint,
  'reservation records the maximum as reserved credits'
);
SELECT is(
  (SELECT count(*) FROM public.aido_credit_ledger WHERE entry_type = 'reserve'),
  1::bigint,
  'reservation appends one reserve ledger entry'
);
SELECT lives_ok(
  $$SELECT * FROM public.aido_reserve_credits(
    '00000000-0000-4000-8000-000000000201', NULL,
    'assignment.autopilot',
    '22000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000001',
    'phase2-job-success', 'phase2-reserve-success',
    60, 80, 1000, now() + interval '1 hour'
  )$$,
  'duplicate reservation request returns the original reservation'
);
SELECT is(
  (SELECT count(*) FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success'),
  1::bigint,
  'duplicate reservation creates no second row'
);
SELECT throws_ok(
  $$SELECT * FROM public.aido_reserve_credits(
    '00000000-0000-4000-8000-000000000201', NULL,
    'assignment.autopilot',
    '22000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000001',
    'phase2-job-success', 'phase2-reserve-success',
    61, 80, 1000, now() + interval '1 hour'
  )$$,
  '23505', NULL,
  'reservation key cannot be reused with a changed quote'
);
SELECT throws_ok(
  $$SELECT * FROM public.aido_reserve_credits(
    '00000000-0000-4000-8000-000000000201', NULL,
    'assignment.autopilot',
    '22000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000001',
    'phase2-job-too-large', 'phase2-reserve-too-large',
    60, 80, 1000, now() + interval '1 hour'
  )$$,
  'P0001', NULL,
  'insufficient available credits block a second provider reservation'
);

SELECT lives_ok(
  $$SELECT public.aido_mark_reservation_running(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success')
  )$$,
  'reserved work can enter running state'
);
SELECT lives_ok(
  $$SELECT public.aido_authorize_provider_call(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success'),
    'phase2-provider-success', 1::smallint,
    600, 500, 300, 0, 0, 0, now() + interval '10 minutes'
  )$$,
  'provider call receives a bounded server authorization'
);
SELECT throws_ok(
  $$SELECT public.aido_authorize_provider_call(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success'),
    'phase2-provider-success', 1::smallint,
    500, 500, 300, 0, 0, 0, now() + interval '10 minutes'
  )$$,
  '23505', NULL,
  'provider authorization key cannot be reused with changed ceilings'
);
SELECT throws_ok(
  $$SELECT public.aido_record_usage_event(
    (SELECT id FROM public.aido_provider_call_authorizations WHERE idempotency_key = 'phase2-provider-success'),
    'phase2-usage-success', 'req_phase2success', 'phase2-prompt-v1',
    400, 0, 250, 0, 0, 0, 1200, 500,
    'succeeded', true, NULL
  )$$,
  '23514', NULL,
  'usage cannot consume an authorization before provider dispatch'
);
SELECT is(
  public.aido_mark_provider_call_dispatched(
    (SELECT id FROM public.aido_provider_call_authorizations WHERE idempotency_key = 'phase2-provider-success')
  ),
  true,
  'the first worker atomically claims provider dispatch'
);
SELECT is(
  public.aido_mark_provider_call_dispatched(
    (SELECT id FROM public.aido_provider_call_authorizations WHERE idempotency_key = 'phase2-provider-success')
  ),
  false,
  'a retry cannot dispatch the same authorized call twice'
);
SELECT lives_ok(
  $$SELECT public.aido_record_usage_event(
    (SELECT id FROM public.aido_provider_call_authorizations WHERE idempotency_key = 'phase2-provider-success'),
    'phase2-usage-success', 'req_phase2success', 'phase2-prompt-v1',
    400, 0, 250, 0, 0, 0, 1200, 500,
    'succeeded', true, NULL
  )$$,
  'successful provider usage is journaled from actual usage'
);
SELECT throws_ok(
  $$SELECT public.aido_record_usage_event(
    (SELECT id FROM public.aido_provider_call_authorizations WHERE idempotency_key = 'phase2-provider-success'),
    'phase2-usage-success', 'req_phase2success', 'phase2-prompt-v1',
    400, 0, 251, 0, 0, 0, 1200, 500,
    'succeeded', true, NULL
  )$$,
  '23505', NULL,
  'usage key cannot be reused with changed actual usage'
);
SELECT lives_ok(
  $$SELECT * FROM public.aido_settle_reservation(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success'),
    60, 'phase2-capture-success'
  )$$,
  'successful work captures only its final credit charge'
);
SELECT is(
  (SELECT captured_credits FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success'),
  60::bigint,
  'settlement persists the captured amount'
);
SELECT is(
  (SELECT available_credits FROM public.aido_credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  40::bigint,
  'unused reserved credits return to the wallet'
);
SELECT is(
  (SELECT available_balance_after FROM public.aido_credit_ledger
   WHERE entry_type = 'capture' AND reservation_id = (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success')),
  20::bigint,
  'capture ledger records the balance before the unused-credit release'
);
SELECT is(
  (SELECT reserved_balance_after FROM public.aido_credit_ledger
   WHERE entry_type = 'capture' AND reservation_id = (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success')),
  20::bigint,
  'capture ledger records only the remaining reserved portion'
);
SELECT lives_ok(
  $$SELECT * FROM public.aido_settle_reservation(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success'),
    60, 'phase2-capture-success'
  )$$,
  'duplicate settlement is idempotent'
);
SELECT is(
  (SELECT count(*) FROM public.aido_credit_ledger
   WHERE entry_type = 'capture' AND reservation_id = (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success')),
  1::bigint,
  'duplicate settlement creates one capture entry'
);
SELECT throws_ok(
  $$SELECT * FROM public.aido_settle_reservation(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-success'),
    60, 'phase2-capture-changed'
  )$$,
  '23505', NULL,
  'settled reservation rejects a different idempotency key'
);

SELECT lives_ok(
  $$SELECT * FROM public.aido_reserve_credits(
    '00000000-0000-4000-8000-000000000201', NULL,
    'assignment.autopilot',
    '22000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000001',
    'phase2-job-failure', 'phase2-reserve-failure',
    20, 30, 500, now() + interval '1 hour'
  )$$,
  'a second affordable job can reserve credits'
);
SELECT lives_ok(
  $$SELECT public.aido_mark_reservation_running(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-failure')
  )$$,
  'failure-path reservation enters running state'
);
SELECT throws_ok(
  $$SELECT public.aido_authorize_provider_call(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-failure'),
    'phase2-provider-over-budget', 1::smallint,
    600, 100, 100, 0, 0, 0, now() + interval '10 minutes'
  )$$,
  'P0001', NULL,
  'provider authorization above the reservation budget is rejected'
);
SELECT lives_ok(
  $$SELECT public.aido_authorize_provider_call(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-failure'),
    'phase2-provider-failure', 1::smallint,
    300, 100, 100, 0, 0, 0, now() + interval '10 minutes'
  )$$,
  'failure-path provider call receives an in-budget authorization'
);
SELECT is(
  public.aido_mark_provider_call_dispatched(
    (SELECT id FROM public.aido_provider_call_authorizations WHERE idempotency_key = 'phase2-provider-failure')
  ),
  true,
  'failed provider work is also marked as dispatched before usage is recorded'
);
SELECT lives_ok(
  $$SELECT public.aido_record_usage_event(
    (SELECT id FROM public.aido_provider_call_authorizations WHERE idempotency_key = 'phase2-provider-failure'),
    'phase2-usage-failure', 'req_phase2failure', 'phase2-prompt-v1',
    100, 0, 50, 0, 0, 0, 900, 200,
    'failed', false, 'provider_timeout'
  )$$,
  'failed provider usage records Aido cost without student billing'
);
SELECT lives_ok(
  $$SELECT * FROM public.aido_release_reservation(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-failure'),
    'failed', 'provider_timeout', 'phase2-release-failure'
  )$$,
  'failed work releases every reserved credit'
);
SELECT is(
  (SELECT available_credits FROM public.aido_credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  40::bigint,
  'failed work charges no student credits'
);
SELECT is(
  (SELECT reserved_credits FROM public.aido_credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  0::bigint,
  'failed work leaves no reserved balance'
);
SELECT is(
  (SELECT actual_provider_cost_microusd FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-failure'),
  200::bigint,
  'failed provider expense is retained as Aido loss'
);
SELECT is(
  (SELECT count(*) FROM public.aido_provider_budget_usage
   WHERE incurred_microusd = 700 AND reserved_microusd = 0),
  4::bigint,
  'all four provider budget scopes reconcile successful and failed cost'
);
SELECT throws_ok(
  $$SELECT * FROM public.aido_release_reservation(
    (SELECT id FROM public.aido_usage_reservations WHERE job_key = 'phase2-job-failure'),
    'failed', 'provider_timeout', 'phase2-release-changed'
  )$$,
  '23505', NULL,
  'terminal release rejects a different idempotency key'
);

SELECT lives_ok(
  $$SELECT * FROM public.aido_process_verified_reversal_event(
    'evt_phase2refundone', 'charge.refunded', false,
    're_phase2refundone', 'cs_phase2purchaseone', 500,
    repeat('b', 64), 'refund'
  )$$,
  'verified refund creates a compensating credit reversal'
);
SELECT is(
  (SELECT available_credits FROM public.aido_credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  0::bigint,
  'refund recovery never drives the wallet negative'
);
SELECT is(
  (SELECT status FROM public.aido_credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  'frozen'::public.aido_wallet_status,
  'consumed refunded credits freeze the wallet for review'
);
SELECT is(
  (SELECT unrecovered_credits FROM public.aido_credit_wallets WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  10::bigint,
  'unrecoverable refund exposure is recorded explicitly'
);
SELECT is(
  (SELECT count(*) FROM public.aido_payment_events WHERE stripe_event_id = 'evt_phase2refundone' AND status = 'processed'),
  1::bigint,
  'refund event is processed exactly once'
);
SELECT lives_ok(
  $$SELECT * FROM public.aido_process_verified_reversal_event(
    'evt_phase2refundone', 'charge.refunded', false,
    're_phase2refundone', 'cs_phase2purchaseone', 500,
    repeat('b', 64), 'refund'
  )$$,
  'duplicate refund delivery is idempotent'
);
SELECT is(
  (SELECT count(*) FROM public.aido_credit_reversals WHERE user_id = '00000000-0000-4000-8000-000000000201'),
  1::bigint,
  'duplicate refund delivery creates one reversal'
);
SELECT throws_ok(
  $$SELECT * FROM public.aido_process_verified_reversal_event(
    'evt_phase2refundone', 'charge.refunded', false,
    're_phase2refundone', 'cs_phase2purchaseone', 400,
    repeat('b', 64), 'refund'
  )$$,
  '23505', NULL,
  'refund event ID cannot be reused with changed reversal facts'
);
SELECT is(
  (SELECT count(*) FROM public.aido_reconciliation_issues()),
  0::bigint,
  'wallets, ledgers, reservations, usage, and payment effects reconcile'
);

INSERT INTO public.aido_provider_call_authorizations (
  reservation_id, user_id, idempotency_key, attempt,
  estimated_cost_microusd, estimated_input_tokens, estimated_output_tokens,
  expires_at, created_at, dispatched_at
)
SELECT
  reservation.id, reservation.user_id, 'phase2-provider-ambiguous', 1,
  100, 10, 10,
  now() - interval '1 minute', now() - interval '2 minutes', now() - interval '90 seconds'
FROM public.aido_usage_reservations reservation
WHERE reservation.job_key = 'phase2-job-success';

SELECT is(
  (SELECT count(*) FROM public.aido_provider_dispatch_reconciliation_issues()),
  1::bigint,
  'an expired dispatched call without usage is surfaced for reconciliation'
);
SELECT is(
  (SELECT details ->> 'provider' FROM public.aido_provider_dispatch_reconciliation_issues()),
  'openai',
  'the unresolved dispatch issue identifies the provider to reconcile'
);
UPDATE public.aido_provider_call_authorizations
SET status = 'released', released_at = now()
WHERE idempotency_key = 'phase2-provider-ambiguous';
SELECT is(
  (SELECT count(*) FROM public.aido_provider_dispatch_reconciliation_issues()),
  1::bigint,
  'releasing student credits does not erase an ambiguous provider expense'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000201","role":"authenticated"}',
  true
);

SELECT is(
  (SELECT count(*) FROM public.aido_credit_wallets),
  1::bigint,
  'owner sees only their own wallet'
);
SELECT ok(
  (SELECT count(*) FROM public.aido_credit_ledger) > 0,
  'owner can read their own ledger history'
);
SELECT throws_ok(
  $$UPDATE public.aido_credit_wallets SET available_credits = 999999$$,
  '42501', NULL,
  'browser-authenticated users cannot alter wallet truth'
);
SELECT throws_ok(
  $$SELECT * FROM public.aido_reserve_credits(
    '00000000-0000-4000-8000-000000000201', NULL,
    'assignment.autopilot',
    '22000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000001',
    'browser-job-denied', 'browser-reserve-denied',
    10, 10, 100, now() + interval '1 hour'
  )$$,
  '42501', NULL,
  'browser-authenticated users cannot invoke financial mutation functions'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000202","role":"authenticated"}',
  true
);
SELECT is(
  (SELECT count(*) FROM public.aido_credit_ledger),
  0::bigint,
  'another user cannot read owner ledger entries'
);
SELECT is(
  (SELECT count(*) FROM public.aido_payment_events),
  0::bigint,
  'another user cannot read owner payment events'
);

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$UPDATE public.aido_credit_ledger
    SET metadata = '{"tampered":true}'::jsonb
    WHERE id = (SELECT min(id) FROM public.aido_credit_ledger)$$,
  '55000', NULL,
  'ledger history is append-only even for trusted service code'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
