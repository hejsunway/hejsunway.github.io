BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(20);

SELECT has_table('public', 'aido_provider_invoice_imports', 'provider invoice imports exist');
SELECT has_table('public', 'aido_reconciliation_runs', 'durable reconciliation runs exist');
SELECT has_table('public', 'aido_reconciliation_run_issues', 'durable reconciliation issues exist');
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.aido_provider_invoice_imports'::regclass),
  'provider invoices have RLS enabled'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.aido_provider_invoice_imports', 'SELECT'),
  'authenticated users cannot inspect provider invoice costs'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.aido_reconciliation_runs', 'INSERT'),
  'authenticated users cannot create reconciliation runs'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.aido_provider_invoice_reconciliation_issues()',
    'EXECUTE'
  ),
  'authenticated users cannot run provider-cost reconciliation'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.aido_provider_invoice_reconciliation_issues()',
    'EXECUTE'
  ),
  'service role can run provider-cost reconciliation'
);

INSERT INTO public.aido_provider_invoice_imports (
  id, provider, invoice_reference, period_start, period_end,
  billed_microusd, source_sha256
) VALUES (
  '41000000-0000-4000-8000-000000000001', 'openai', 'invoice-original',
  now() - interval '30 days', now(), 1500, repeat('a', 64)
);

SET LOCAL ROLE service_role;

SELECT is(
  (SELECT count(*) FROM public.aido_provider_invoice_reconciliation_issues()),
  1::bigint,
  'invoice total without matching usage is reported'
);
SELECT is(
  (SELECT (details ->> 'difference_microusd')::bigint
   FROM public.aido_provider_invoice_reconciliation_issues()),
  1500::bigint,
  'provider cost difference is exact integer microusd'
);
SELECT lives_ok(
  $$INSERT INTO public.aido_provider_invoice_imports (
    id, provider, invoice_reference, period_start, period_end,
    billed_microusd, source_sha256, supersedes_invoice_id
  ) SELECT
    '41000000-0000-4000-8000-000000000002', provider, 'invoice-correction',
    period_start, period_end, 0, repeat('b', 64), id
  FROM public.aido_provider_invoice_imports
  WHERE id = '41000000-0000-4000-8000-000000000001'$$,
  'a correction can supersede the same provider and period'
);
SELECT is(
  (SELECT count(*) FROM public.aido_provider_invoice_reconciliation_issues()),
  0::bigint,
  'only the latest immutable invoice correction is reconciled'
);
SELECT throws_ok(
  $$INSERT INTO public.aido_provider_invoice_imports (
    provider, invoice_reference, period_start, period_end,
    billed_microusd, source_sha256, supersedes_invoice_id
  ) VALUES (
    'other-provider', 'invoice-invalid-correction', now() - interval '30 days', now(),
    0, repeat('c', 64), '41000000-0000-4000-8000-000000000002'
  )$$,
  '22023', NULL,
  'correction cannot supersede a different provider or period'
);
SELECT throws_ok(
  $$UPDATE public.aido_provider_invoice_imports SET billed_microusd = 1
    WHERE id = '41000000-0000-4000-8000-000000000002'$$,
  '55000', NULL,
  'provider invoice history is immutable'
);

INSERT INTO public.aido_reconciliation_runs (id, scope)
VALUES ('42000000-0000-4000-8000-000000000001', 'test');
INSERT INTO public.aido_reconciliation_run_issues (
  run_id, severity, category, entity_id, details
) VALUES (
  '42000000-0000-4000-8000-000000000001', 'critical',
  'test_mismatch', 'test-entity', '{"expected":1,"actual":2}'::jsonb
);
UPDATE public.aido_reconciliation_runs
SET status = 'completed', internal_checked_count = 4, issue_count = 1,
    completed_at = now()
WHERE id = '42000000-0000-4000-8000-000000000001';

SELECT is(
  (SELECT status FROM public.aido_reconciliation_runs WHERE id = '42000000-0000-4000-8000-000000000001'),
  'completed'::public.aido_reconciliation_run_status,
  'reconciliation run records terminal completion'
);
SELECT is(
  (SELECT issue_count FROM public.aido_reconciliation_runs WHERE id = '42000000-0000-4000-8000-000000000001'),
  1,
  'reconciliation run records its issue count'
);
SELECT is(
  (SELECT severity FROM public.aido_reconciliation_run_issues WHERE run_id = '42000000-0000-4000-8000-000000000001'),
  'critical'::public.aido_reconciliation_issue_severity,
  'durable issue records severity'
);
SELECT throws_ok(
  $$UPDATE public.aido_reconciliation_run_issues SET details = '{}'::jsonb$$,
  '55000', NULL,
  'reconciliation issue history is immutable'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000999","role":"authenticated"}',
  true
);
SELECT throws_ok(
  $$INSERT INTO public.aido_reconciliation_runs (scope) VALUES ('browser')$$,
  '42501', NULL,
  'browser-authenticated users cannot schedule their own reconciliation'
);
SELECT throws_ok(
  $$SELECT * FROM public.aido_provider_invoice_reconciliation_issues()$$,
  '42501', NULL,
  'browser-authenticated users cannot query provider invoice discrepancies'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
