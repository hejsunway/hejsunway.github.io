BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(24);

SELECT has_table('public', 'aido_subscriptions', 'subscription projection exists');
SELECT has_table('public', 'aido_subscription_events', 'subscription event journal exists');
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.aido_subscriptions'::regclass),
  'subscription projection has RLS enabled'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.aido_subscription_events'::regclass),
  'subscription event journal has RLS enabled'
);
SELECT ok(
  has_table_privilege('authenticated', 'public.aido_subscriptions', 'SELECT'),
  'authenticated users can read their own subscription projection'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.aido_subscriptions', 'UPDATE'),
  'authenticated users cannot update subscription truth'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.aido_subscription_events', 'SELECT'),
  'authenticated users cannot read the internal event journal'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.aido_process_verified_subscription_event(text,text,timestamp with time zone,text,boolean,text,text,text,aido_subscription_status,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)',
    'EXECUTE'
  ),
  'authenticated users cannot submit Stripe subscription facts'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.aido_process_verified_subscription_event(text,text,timestamp with time zone,text,boolean,text,text,text,aido_subscription_status,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)',
    'EXECUTE'
  ),
  'service role can process verified subscription facts'
);

INSERT INTO auth.users (id, email, is_sso_user, is_anonymous)
VALUES
  ('00000000-0000-4000-8000-000000000301', 'subscription-owner@example.test', false, false),
  ('00000000-0000-4000-8000-000000000302', 'subscription-other@example.test', false, false);

INSERT INTO public.aido_credit_products (
  id, product_key, version, kind, stripe_product_id, stripe_price_id,
  amount_sen, credit_grant, expires_after_days, effective_from
) VALUES
  (
    '34000000-0000-4000-8000-000000000001',
    'subscription.phase2', 1, 'subscription', 'prod_subscriptiontest',
    'price_subscriptiontest', 2900, 300, 31, now() - interval '1 hour'
  ),
  (
    '34000000-0000-4000-8000-000000000002',
    'topup.subscriptiontest', 1, 'topup', 'prod_subscriptiontopup',
    'price_subscriptiontopup', 1000, 100, 365, now() - interval '1 hour'
  );

INSERT INTO public.aido_payment_customers (user_id, stripe_customer_id)
VALUES
  ('00000000-0000-4000-8000-000000000301', 'cus_subscriptionowner'),
  ('00000000-0000-4000-8000-000000000302', 'cus_subscriptionother');

SET LOCAL ROLE service_role;

SELECT is(
  public.aido_process_verified_subscription_event(
    'evt_subscriptioncreated', 'customer.subscription.created', now(),
    repeat('a', 64), false, 'sub_subscriptionowner', 'cus_subscriptionowner',
    'price_subscriptiontest', 'active', false,
    now() - interval '1 day', now() + interval '30 days',
    p_latest_invoice_id => 'in_subscriptionfirst'
  ),
  'applied',
  'verified subscription event creates the projection'
);
SELECT is(
  (SELECT count(*) FROM public.aido_subscriptions WHERE stripe_subscription_id = 'sub_subscriptionowner'),
  1::bigint,
  'one subscription projection is stored'
);
SELECT is(
  (SELECT user_id FROM public.aido_subscriptions WHERE stripe_subscription_id = 'sub_subscriptionowner'),
  '00000000-0000-4000-8000-000000000301'::uuid,
  'Stripe customer mapping determines the subscription owner'
);
SELECT is(
  (SELECT status FROM public.aido_subscriptions WHERE stripe_subscription_id = 'sub_subscriptionowner'),
  'active'::public.aido_subscription_status,
  'the authoritative Stripe status is projected'
);
SELECT is(
  public.aido_process_verified_subscription_event(
    'evt_subscriptioncreated', 'customer.subscription.created', now(),
    repeat('a', 64), false, 'sub_subscriptionowner', 'cus_subscriptionowner',
    'price_subscriptiontest', 'active', false,
    now() - interval '1 day', now() + interval '30 days',
    p_latest_invoice_id => 'in_subscriptionfirst'
  ),
  'duplicate',
  'duplicate Stripe delivery is idempotent'
);
SELECT is(
  (SELECT count(*) FROM public.aido_subscription_events WHERE stripe_event_id = 'evt_subscriptioncreated'),
  1::bigint,
  'duplicate delivery leaves one journal row'
);
SELECT is(
  public.aido_process_verified_subscription_event(
    'evt_subscriptionstale', 'customer.subscription.updated', now() - interval '1 day',
    repeat('b', 64), false, 'sub_subscriptionowner', 'cus_subscriptionowner',
    'price_subscriptiontest', 'canceled', false,
    now() - interval '2 days', now() + interval '29 days'
  ),
  'stale',
  'out-of-order Stripe event is journaled without replacing newer truth'
);
SELECT is(
  (SELECT status FROM public.aido_subscriptions WHERE stripe_subscription_id = 'sub_subscriptionowner'),
  'active'::public.aido_subscription_status,
  'stale event does not regress subscription status'
);
SELECT is(
  (SELECT projection_applied FROM public.aido_subscription_events WHERE stripe_event_id = 'evt_subscriptionstale'),
  false,
  'stale journal row records that no projection was applied'
);
SELECT throws_ok(
  $$SELECT public.aido_process_verified_subscription_event(
    'evt_subscriptioncreated', 'customer.subscription.created', now(),
    repeat('c', 64), false, 'sub_subscriptionowner', 'cus_subscriptionowner',
    'price_subscriptiontest', 'active', false,
    now() - interval '1 day', now() + interval '30 days'
  )$$,
  'P0001', NULL,
  'an event ID cannot be reused with changed facts'
);
SELECT throws_ok(
  $$SELECT public.aido_process_verified_subscription_event(
    'evt_subscriptionwrongcustomer', 'customer.subscription.updated', now(),
    repeat('d', 64), false, 'sub_subscriptionowner', 'cus_subscriptionother',
    'price_subscriptiontest', 'active', false,
    now() - interval '1 day', now() + interval '30 days'
  )$$,
  'P0001', NULL,
  'a subscription cannot be rebound to a different Aido user'
);
SELECT throws_ok(
  $$SELECT public.aido_process_verified_subscription_event(
    'evt_subscriptiontopupprice', 'customer.subscription.created', now(),
    repeat('e', 64), false, 'sub_subscriptioninvalid', 'cus_subscriptionowner',
    'price_subscriptiontopup', 'active', false,
    now() - interval '1 day', now() + interval '30 days'
  )$$,
  'P0001', NULL,
  'a one-time top-up price cannot become a subscription projection'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000301","role":"authenticated"}',
  true
);
SELECT is(
  (SELECT count(*) FROM public.aido_subscriptions),
  1::bigint,
  'owner can read their subscription projection'
);
SELECT throws_ok(
  $$UPDATE public.aido_subscriptions SET status = 'active'$$,
  '42501', NULL,
  'browser-authenticated owner cannot alter subscription truth'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000302","role":"authenticated"}',
  true
);
SELECT is(
  (SELECT count(*) FROM public.aido_subscriptions),
  0::bigint,
  'another user cannot read the owner subscription'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
