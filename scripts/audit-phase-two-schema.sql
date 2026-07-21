-- Read-only Phase 2 schema and privilege report.
-- Run on local, staging, or production candidates and require every row to
-- report pass=true. This query does not read user, payment, or usage rows.

WITH
expected_migrations(migration_name) AS (
  VALUES
    ('aido_phase_two_billing_core'),
    ('aido_phase_two_atomic_operations'),
    ('aido_phase_two_subscription_lifecycle'),
    ('aido_phase_two_reconciliation'),
    ('aido_phase_two_reconciliation_index_hardening'),
    ('aido_phase_two_provider_dispatch_hardening'),
    ('aido_phase_two_configuration_import'),
    ('aido_phase_two_dispatch_reconciliation_durability'),
    ('aido_phase_two_scheduled_expiry'),
    ('aido_phase_two_cache_write_accounting')
),
expected_tables(table_name) AS (
  VALUES
    ('aido_billing_config_versions'),
    ('aido_provider_prices'),
    ('aido_feature_rate_cards'),
    ('aido_provider_routes'),
    ('aido_credit_products'),
    ('aido_system_controls'),
    ('aido_provider_budget_usage'),
    ('aido_payment_customers'),
    ('aido_payment_events'),
    ('aido_credit_wallets'),
    ('aido_credit_lots'),
    ('aido_usage_reservations'),
    ('aido_usage_events'),
    ('aido_credit_ledger'),
    ('aido_credit_reservation_allocations'),
    ('aido_credit_reversals'),
    ('aido_provider_call_authorizations'),
    ('aido_subscriptions'),
    ('aido_subscription_events'),
    ('aido_provider_invoice_imports'),
    ('aido_reconciliation_runs'),
    ('aido_reconciliation_run_issues'),
    ('aido_billing_configuration_imports')
),
authenticated_read_tables(table_name) AS (
  VALUES
    ('aido_payment_events'),
    ('aido_credit_wallets'),
    ('aido_credit_lots'),
    ('aido_usage_reservations'),
    ('aido_usage_events'),
    ('aido_credit_ledger'),
    ('aido_credit_reservation_allocations'),
    ('aido_credit_reversals'),
    ('aido_provider_call_authorizations'),
    ('aido_subscriptions')
),
service_functions(signature) AS (
  VALUES
    ('public.aido_reserve_credits(uuid,uuid,text,uuid,uuid,text,text,bigint,bigint,bigint,timestamp with time zone)'),
    ('public.aido_authorize_provider_call(uuid,text,smallint,bigint,bigint,bigint,integer,integer,integer,timestamp with time zone)'),
    ('public.aido_mark_provider_call_dispatched(uuid)'),
    ('public.aido_expire_due_financial_state(integer)'),
    ('public.aido_record_usage_event(uuid,text,text,text,bigint,bigint,bigint,bigint,integer,integer,integer,integer,bigint,public.aido_usage_outcome,boolean,text)'),
    ('public.aido_settle_reservation(uuid,bigint,text)'),
    ('public.aido_release_reservation(uuid,public.aido_usage_reservation_status,text,text)'),
    ('public.aido_process_verified_purchase_event(text,text,public.aido_payment_event_kind,boolean,text,text,text,text,bigint,bigint,text)'),
    ('public.aido_process_verified_reversal_event(text,text,boolean,text,text,bigint,text,public.aido_credit_reversal_type)'),
    ('public.aido_process_verified_subscription_event(text,text,timestamp with time zone,text,boolean,text,text,text,public.aido_subscription_status,boolean,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)'),
    ('public.aido_apply_billing_configuration(jsonb,text,uuid)'),
    ('public.aido_reconciliation_issues()'),
    ('public.aido_provider_invoice_reconciliation_issues()'),
    ('public.aido_provider_dispatch_reconciliation_issues()'),
    ('public.aido_expiry_reconciliation_issues()')
),
expected_indexes(index_name) AS (
  VALUES
    ('idx_aido_subscription_events_credit_product'),
    ('idx_aido_provider_invoice_imports_imported_by'),
    ('idx_aido_provider_call_authorizations_unresolved_dispatch'),
    ('idx_aido_billing_configuration_imports_applied_by')
),
checks(check_order, check_name, expected, actual, pass) AS (
  SELECT 10, 'Phase 2 migration history', 'all ten canonical migrations recorded',
    coalesce((SELECT jsonb_agg(migration_name ORDER BY migration_name)::text
      FROM expected_migrations expected
      WHERE NOT EXISTS (
        SELECT 1 FROM supabase_migrations.schema_migrations applied
        WHERE applied.name = expected.migration_name
      )), '[]'),
    NOT EXISTS (
      SELECT 1 FROM expected_migrations expected
      WHERE NOT EXISTS (
        SELECT 1 FROM supabase_migrations.schema_migrations applied
        WHERE applied.name = expected.migration_name
      )
    )
  UNION ALL
  SELECT 20, 'Phase 2 tables', 'all twenty-three tables exist',
    coalesce((SELECT jsonb_agg(table_name ORDER BY table_name)::text
      FROM expected_tables expected
      WHERE to_regclass('public.' || expected.table_name) IS NULL), '[]'),
    NOT EXISTS (
      SELECT 1 FROM expected_tables expected
      WHERE to_regclass('public.' || expected.table_name) IS NULL
    )
  UNION ALL
  SELECT 30, 'RLS enabled', 'RLS enabled on all Phase 2 tables',
    coalesce((SELECT jsonb_agg(table_name ORDER BY table_name)::text
      FROM expected_tables expected
      LEFT JOIN pg_class relation ON relation.oid = to_regclass('public.' || expected.table_name)
      WHERE NOT coalesce(relation.relrowsecurity, false)), '[]'),
    NOT EXISTS (
      SELECT 1 FROM expected_tables expected
      LEFT JOIN pg_class relation ON relation.oid = to_regclass('public.' || expected.table_name)
      WHERE NOT coalesce(relation.relrowsecurity, false)
    )
  UNION ALL
  SELECT 40, 'Authenticated read surface', 'only read-own tables have SELECT grants',
    coalesce((SELECT jsonb_agg(table_name ORDER BY table_name)::text
      FROM expected_tables expected
      WHERE has_table_privilege('authenticated', 'public.' || expected.table_name, 'SELECT')
        IS DISTINCT FROM EXISTS (
          SELECT 1 FROM authenticated_read_tables allowed
          WHERE allowed.table_name = expected.table_name
        )), '[]'),
    NOT EXISTS (
      SELECT 1 FROM expected_tables expected
      WHERE has_table_privilege('authenticated', 'public.' || expected.table_name, 'SELECT')
        IS DISTINCT FROM EXISTS (
          SELECT 1 FROM authenticated_read_tables allowed
          WHERE allowed.table_name = expected.table_name
        )
    )
  UNION ALL
  SELECT 50, 'Authenticated mutation boundary', 'no Phase 2 table mutation grants',
    coalesce((SELECT jsonb_agg(table_name ORDER BY table_name)::text
      FROM expected_tables expected
      WHERE has_table_privilege(
        'authenticated', 'public.' || expected.table_name,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )), '[]'),
    NOT EXISTS (
      SELECT 1 FROM expected_tables expected
      WHERE has_table_privilege(
        'authenticated', 'public.' || expected.table_name,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
    )
  UNION ALL
  SELECT 60, 'Service-only financial RPCs', 'service can execute and authenticated/anon cannot',
    coalesce((SELECT jsonb_agg(signature ORDER BY signature)::text
      FROM service_functions expected
      WHERE to_regprocedure(expected.signature) IS NULL
         OR NOT coalesce(has_function_privilege('service_role', to_regprocedure(expected.signature), 'EXECUTE'), false)
         OR coalesce(has_function_privilege('authenticated', to_regprocedure(expected.signature), 'EXECUTE'), false)
         OR coalesce(has_function_privilege('anon', to_regprocedure(expected.signature), 'EXECUTE'), false)), '[]'),
    NOT EXISTS (
      SELECT 1 FROM service_functions expected
      WHERE to_regprocedure(expected.signature) IS NULL
         OR NOT coalesce(has_function_privilege('service_role', to_regprocedure(expected.signature), 'EXECUTE'), false)
         OR coalesce(has_function_privilege('authenticated', to_regprocedure(expected.signature), 'EXECUTE'), false)
         OR coalesce(has_function_privilege('anon', to_regprocedure(expected.signature), 'EXECUTE'), false)
    )
  UNION ALL
  SELECT 70, 'Private financial schema', 'browser roles have no USAGE',
    'authenticated=' || has_schema_privilege('authenticated', 'aido_private', 'USAGE')::text
      || ', anon=' || has_schema_privilege('anon', 'aido_private', 'USAGE')::text,
    NOT has_schema_privilege('authenticated', 'aido_private', 'USAGE')
      AND NOT has_schema_privilege('anon', 'aido_private', 'USAGE')
  UNION ALL
  SELECT 80, 'Phase 2 hardening indexes', 'all required hardening indexes exist',
    coalesce((SELECT jsonb_agg(index_name ORDER BY index_name)::text
      FROM expected_indexes expected
      WHERE to_regclass('public.' || expected.index_name) IS NULL), '[]'),
    NOT EXISTS (
      SELECT 1 FROM expected_indexes expected
      WHERE to_regclass('public.' || expected.index_name) IS NULL
    )
)
SELECT check_name, expected, actual, pass
FROM checks
ORDER BY check_order;
