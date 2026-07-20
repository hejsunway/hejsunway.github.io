BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(14);

SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'public.aido_expire_due_financial_state(integer)', 'EXECUTE'
  ),
  'authenticated users cannot run financial expiry maintenance'
);
SELECT ok(
  has_function_privilege(
    'service_role', 'public.aido_expire_due_financial_state(integer)', 'EXECUTE'
  ),
  'service role can run bounded financial expiry maintenance'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated', 'public.aido_expiry_reconciliation_issues()', 'EXECUTE'
  ),
  'authenticated users cannot inspect internal expiry discrepancies'
);
SELECT ok(
  has_function_privilege(
    'service_role', 'public.aido_expiry_reconciliation_issues()', 'EXECUTE'
  ),
  'service role can reconcile overdue financial state'
);

INSERT INTO auth.users (id, email, is_sso_user, is_anonymous)
VALUES ('00000000-0000-4000-8000-000000000601', 'maintenance-owner@example.test', false, false);
INSERT INTO public.aido_product_memberships (user_id, status, role)
VALUES ('00000000-0000-4000-8000-000000000601', 'active', 'student');
INSERT INTO public.aido_credit_wallets (user_id, available_credits, version)
VALUES ('00000000-0000-4000-8000-000000000601', 10, 1);
INSERT INTO public.aido_credit_lots (
  id, user_id, source, granted_credits, remaining_credits,
  reserved_credits, status, expires_at, created_at
) VALUES (
  '61000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000601',
  'admin', 10, 10, 0, 'active',
  now() - interval '1 hour', now() - interval '2 hours'
);
INSERT INTO public.aido_credit_ledger (
  user_id, entry_type, credit_lot_id, available_delta,
  available_balance_after, reserved_balance_after,
  unrecovered_balance_after, idempotency_key
) VALUES (
  '00000000-0000-4000-8000-000000000601', 'grant',
  '61000000-0000-4000-8000-000000000001', 10,
  10, 0, 0, 'maintenance-test-grant'
);

SET LOCAL ROLE service_role;

SELECT is(
  (SELECT count(*) FROM public.aido_expiry_reconciliation_issues()),
  1::bigint,
  'an overdue unreserved credit lot is visible before maintenance'
);
SELECT throws_ok(
  $$SELECT public.aido_expire_due_financial_state(0)$$,
  '22023', NULL,
  'maintenance rejects an unbounded or empty batch request'
);
SELECT is(
  (public.aido_expire_due_financial_state(100) ->> 'expired_credit_lots')::integer,
  1,
  'maintenance expires the due credit lot'
);
SELECT is(
  jsonb_array_length(public.aido_expire_due_financial_state(100) -> 'failures'),
  0,
  'a clean repeated maintenance batch reports no failures'
);
SELECT is(
  (SELECT available_credits FROM public.aido_credit_wallets
   WHERE user_id = '00000000-0000-4000-8000-000000000601'),
  0::bigint,
  'expired credits are removed from the available wallet balance'
);
SELECT is(
  (SELECT status FROM public.aido_credit_lots WHERE id = '61000000-0000-4000-8000-000000000001'),
  'expired'::public.aido_credit_lot_status,
  'the credit lot reaches its terminal expired state'
);
SELECT is(
  (SELECT count(*) FROM public.aido_credit_ledger
   WHERE credit_lot_id = '61000000-0000-4000-8000-000000000001' AND entry_type = 'expiry'),
  1::bigint,
  'maintenance appends exactly one expiry ledger entry'
);
SELECT is(
  (SELECT count(*) FROM public.aido_expiry_reconciliation_issues()),
  0::bigint,
  'successful maintenance clears the overdue expiry discrepancy'
);
SELECT is(
  (public.aido_expire_due_financial_state(100) ->> 'expired_credit_lots')::integer,
  0,
  'repeating maintenance has no second financial effect'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000601","role":"authenticated"}',
  true
);
SELECT throws_ok(
  $$SELECT public.aido_expire_due_financial_state(100)$$,
  '42501', NULL,
  'browser-authenticated users cannot invoke maintenance'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
