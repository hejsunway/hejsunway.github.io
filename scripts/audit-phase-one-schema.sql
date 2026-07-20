-- Read-only Phase 1 drift report.
--
-- This statement reads only PostgreSQL/Supabase metadata and the private
-- assignment bucket configuration. It never reads Auth users, project rows,
-- assignment content, or Storage objects, and it performs no mutation.
-- Run it against local, staging, or linked environments and require every row
-- to report `pass = true` before treating that environment as Phase 1-ready.

WITH
expected_migrations(version, migration_name) AS (
  VALUES
    ('20260719000000', 'aido_product_memberships'),
    ('20260719123037', 'aido_phase_one_projects'),
    ('20260719141159', 'aido_phase_one_completion'),
    ('20260719142000', 'aido_phase_one_privilege_hardening')
),
expected_tables(table_name) AS (
  VALUES
    ('aido_product_memberships'),
    ('aido_writing_projects'),
    ('aido_project_members'),
    ('aido_assignment_documents'),
    ('aido_project_activity'),
    ('aido_project_policies'),
    ('aido_project_deletion_audit')
),
expected_completion_columns(table_name, column_name) AS (
  VALUES
    ('aido_assignment_documents', 'replaces_document_id'),
    ('aido_assignment_documents', 'replaced_by_document_id'),
    ('aido_assignment_documents', 'replaced_at')
),
expected_public_policies(table_name, policy_name) AS (
  VALUES
    ('aido_product_memberships', 'Aido members read own row'),
    ('aido_product_memberships', 'Aido members insert own row'),
    ('aido_product_memberships', 'Aido members update own row'),
    ('aido_product_memberships', 'Aido members delete own row'),
    ('aido_writing_projects', 'Aido owners read projects'),
    ('aido_writing_projects', 'Aido owners insert projects'),
    ('aido_writing_projects', 'Aido owners update projects'),
    ('aido_writing_projects', 'Aido owners delete projects'),
    ('aido_project_members', 'Aido owners read project members'),
    ('aido_project_members', 'Aido owners insert own owner membership'),
    ('aido_assignment_documents', 'Aido owners read assignment documents'),
    ('aido_assignment_documents', 'Aido owners insert assignment documents'),
    ('aido_assignment_documents', 'Aido owners replace assignment documents'),
    ('aido_project_activity', 'Aido owners read project activity'),
    ('aido_project_activity', 'Aido owners append project activity'),
    ('aido_project_policies', 'Aido owners read project policies'),
    ('aido_project_policies', 'Aido owners insert project policies'),
    ('aido_project_policies', 'Aido owners update project policies'),
    ('aido_project_deletion_audit', 'Aido owners read project deletion audit'),
    ('aido_project_deletion_audit', 'Aido owners append project deletion audit')
),
expected_storage_policies(policy_name) AS (
  VALUES
    ('Aido owners read assignment files'),
    ('Aido owners upload assignment files'),
    ('Aido owners delete assignment files')
),
expected_client_functions(signature) AS (
  VALUES
    ('public.aido_create_project(text,text,text,date,integer,text,public.aido_integrity_mode,text)'),
    ('public.aido_register_assignment_document(uuid,public.aido_document_kind,text,text,text,bigint,text)'),
    ('public.aido_complete_project_setup(uuid)'),
    ('public.aido_replace_assignment_document(uuid,uuid,public.aido_document_kind,text,text,text,bigint,text)'),
    ('public.aido_delete_project(uuid)')
),
expected_internal_functions(signature) AS (
  VALUES
    ('public.aido_set_updated_at()'),
    ('public.aido_validate_project_status()'),
    ('public.aido_validate_assignment_document()'),
    ('public.aido_enforce_document_limits()')
),
expected_authenticated_privileges(table_name, privilege_name) AS (
  VALUES
    ('aido_product_memberships', 'SELECT'),
    ('aido_product_memberships', 'INSERT'),
    ('aido_product_memberships', 'UPDATE'),
    ('aido_product_memberships', 'DELETE'),
    ('aido_writing_projects', 'SELECT'),
    ('aido_writing_projects', 'INSERT'),
    ('aido_writing_projects', 'UPDATE'),
    ('aido_writing_projects', 'DELETE'),
    ('aido_project_members', 'SELECT'),
    ('aido_project_members', 'INSERT'),
    ('aido_assignment_documents', 'SELECT'),
    ('aido_assignment_documents', 'INSERT'),
    ('aido_assignment_documents', 'UPDATE'),
    ('aido_project_activity', 'SELECT'),
    ('aido_project_activity', 'INSERT'),
    ('aido_project_policies', 'SELECT'),
    ('aido_project_policies', 'INSERT'),
    ('aido_project_policies', 'UPDATE'),
    ('aido_project_deletion_audit', 'SELECT'),
    ('aido_project_deletion_audit', 'INSERT')
),
forbidden_authenticated_privileges(table_name, privilege_name) AS (
  VALUES
    ('aido_product_memberships', 'TRUNCATE'),
    ('aido_product_memberships', 'REFERENCES'),
    ('aido_product_memberships', 'TRIGGER'),
    ('aido_writing_projects', 'TRUNCATE'),
    ('aido_writing_projects', 'REFERENCES'),
    ('aido_writing_projects', 'TRIGGER'),
    ('aido_project_members', 'UPDATE'),
    ('aido_project_members', 'DELETE'),
    ('aido_project_members', 'TRUNCATE'),
    ('aido_project_members', 'REFERENCES'),
    ('aido_project_members', 'TRIGGER'),
    ('aido_assignment_documents', 'DELETE'),
    ('aido_assignment_documents', 'TRUNCATE'),
    ('aido_assignment_documents', 'REFERENCES'),
    ('aido_assignment_documents', 'TRIGGER'),
    ('aido_project_activity', 'UPDATE'),
    ('aido_project_activity', 'DELETE'),
    ('aido_project_activity', 'TRUNCATE'),
    ('aido_project_activity', 'REFERENCES'),
    ('aido_project_activity', 'TRIGGER'),
    ('aido_project_policies', 'DELETE'),
    ('aido_project_policies', 'TRUNCATE'),
    ('aido_project_policies', 'REFERENCES'),
    ('aido_project_policies', 'TRIGGER'),
    ('aido_project_deletion_audit', 'UPDATE'),
    ('aido_project_deletion_audit', 'DELETE'),
    ('aido_project_deletion_audit', 'TRUNCATE'),
    ('aido_project_deletion_audit', 'REFERENCES'),
    ('aido_project_deletion_audit', 'TRIGGER')
),
checks(check_order, check_name, expected, actual, pass) AS (
  SELECT
    10,
    'Phase 1 migration history',
    'all four reviewed versions or canonical names recorded',
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object('version', version, 'name', migration_name)
        ORDER BY version
      )::text
      FROM expected_migrations expected
      WHERE NOT EXISTS (
        SELECT 1
        FROM supabase_migrations.schema_migrations applied
        WHERE applied.version = expected.version
           OR applied.name = expected.migration_name
      )
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM expected_migrations expected
      WHERE NOT EXISTS (
        SELECT 1
        FROM supabase_migrations.schema_migrations applied
        WHERE applied.version = expected.version
           OR applied.name = expected.migration_name
      )
    )
  UNION ALL
  SELECT
    20,
    'Phase 1 tables',
    'all seven tables exist',
    coalesce((
      SELECT jsonb_agg(table_name ORDER BY table_name)::text
      FROM expected_tables expected
      WHERE to_regclass('public.' || expected.table_name) IS NULL
    ), '[]'),
    NOT EXISTS (
      SELECT 1 FROM expected_tables expected
      WHERE to_regclass('public.' || expected.table_name) IS NULL
    )
  UNION ALL
  SELECT
    30,
    'Completion columns',
    'all replacement columns exist',
    coalesce((
      SELECT jsonb_agg(column_name ORDER BY column_name)::text
      FROM expected_completion_columns expected
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns column_metadata
        WHERE column_metadata.table_schema = 'public'
          AND column_metadata.table_name = expected.table_name
          AND column_metadata.column_name = expected.column_name
      )
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM expected_completion_columns expected
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns column_metadata
        WHERE column_metadata.table_schema = 'public'
          AND column_metadata.table_name = expected.table_name
          AND column_metadata.column_name = expected.column_name
      )
    )
  UNION ALL
  SELECT
    40,
    'RLS enabled',
    'RLS enabled on all seven tables',
    coalesce((
      SELECT jsonb_agg(table_name ORDER BY table_name)::text
      FROM expected_tables expected
      LEFT JOIN pg_class relation
        ON relation.oid = to_regclass('public.' || expected.table_name)
      WHERE NOT coalesce(relation.relrowsecurity, false)
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM expected_tables expected
      LEFT JOIN pg_class relation
        ON relation.oid = to_regclass('public.' || expected.table_name)
      WHERE NOT coalesce(relation.relrowsecurity, false)
    )
  UNION ALL
  SELECT
    50,
    'Public-schema RLS policies',
    'all twenty owner-scoped policies exist',
    coalesce((
      SELECT jsonb_agg(policy_name ORDER BY table_name, policy_name)::text
      FROM expected_public_policies expected
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_policies policy
        WHERE policy.schemaname = 'public'
          AND policy.tablename = expected.table_name
          AND policy.policyname = expected.policy_name
      )
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM expected_public_policies expected
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_policies policy
        WHERE policy.schemaname = 'public'
          AND policy.tablename = expected.table_name
          AND policy.policyname = expected.policy_name
      )
    )
  UNION ALL
  SELECT
    60,
    'Client RPC privileges',
    'functions exist; authenticated can execute; anon cannot',
    coalesce((
      SELECT jsonb_agg(signature ORDER BY signature)::text
      FROM expected_client_functions expected
      WHERE to_regprocedure(expected.signature) IS NULL
         OR NOT coalesce(has_function_privilege(
              'authenticated', to_regprocedure(expected.signature), 'EXECUTE'
            ), false)
         OR coalesce(has_function_privilege(
              'anon', to_regprocedure(expected.signature), 'EXECUTE'
            ), false)
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM expected_client_functions expected
      WHERE to_regprocedure(expected.signature) IS NULL
         OR NOT coalesce(has_function_privilege(
              'authenticated', to_regprocedure(expected.signature), 'EXECUTE'
            ), false)
         OR coalesce(has_function_privilege(
              'anon', to_regprocedure(expected.signature), 'EXECUTE'
            ), false)
    )
  UNION ALL
  SELECT
    70,
    'Internal function privileges',
    'functions exist; anon and authenticated cannot execute',
    coalesce((
      SELECT jsonb_agg(signature ORDER BY signature)::text
      FROM expected_internal_functions expected
      WHERE to_regprocedure(expected.signature) IS NULL
         OR coalesce(has_function_privilege(
              'authenticated', to_regprocedure(expected.signature), 'EXECUTE'
            ), false)
         OR coalesce(has_function_privilege(
              'anon', to_regprocedure(expected.signature), 'EXECUTE'
            ), false)
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM expected_internal_functions expected
      WHERE to_regprocedure(expected.signature) IS NULL
         OR coalesce(has_function_privilege(
              'authenticated', to_regprocedure(expected.signature), 'EXECUTE'
            ), false)
         OR coalesce(has_function_privilege(
              'anon', to_regprocedure(expected.signature), 'EXECUTE'
            ), false)
    )
  UNION ALL
  SELECT
    80,
    'Required authenticated table privileges',
    'every required privilege is present',
    coalesce((
      SELECT jsonb_agg(
        (table_name || ':' || privilege_name) ORDER BY table_name, privilege_name
      )::text
      FROM expected_authenticated_privileges expected
      WHERE NOT coalesce(has_table_privilege(
        'authenticated', to_regclass('public.' || expected.table_name), expected.privilege_name
      ), false)
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM expected_authenticated_privileges expected
      WHERE NOT coalesce(has_table_privilege(
        'authenticated', to_regclass('public.' || expected.table_name), expected.privilege_name
      ), false)
    )
  UNION ALL
  SELECT
    90,
    'Authenticated table privileges',
    'no unsafe or unnecessary privilege',
    coalesce((
      SELECT jsonb_agg(
        (table_name || ':' || privilege_name) ORDER BY table_name, privilege_name
      )::text
      FROM forbidden_authenticated_privileges forbidden
      WHERE coalesce(has_table_privilege(
        'authenticated', to_regclass('public.' || forbidden.table_name), forbidden.privilege_name
      ), false)
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM forbidden_authenticated_privileges forbidden
      WHERE coalesce(has_table_privilege(
        'authenticated', to_regclass('public.' || forbidden.table_name), forbidden.privilege_name
      ), false)
    )
  UNION ALL
  SELECT
    100,
    'Anonymous table privileges',
    'no privilege on any Phase 1 table',
    coalesce((
      SELECT jsonb_agg(
        (table_name || ':' || privilege_name) ORDER BY table_name, privilege_name
      )::text
      FROM expected_tables expected
      CROSS JOIN unnest(ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]) AS privilege(privilege_name)
      WHERE coalesce(has_table_privilege(
        'anon', to_regclass('public.' || expected.table_name), privilege.privilege_name
      ), false)
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM expected_tables expected
      CROSS JOIN unnest(ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]) AS privilege(privilege_name)
      WHERE coalesce(has_table_privilege(
        'anon', to_regclass('public.' || expected.table_name), privilege.privilege_name
      ), false)
    )
  UNION ALL
  SELECT
    110,
    'Identity-sequence privileges',
    'authenticated has USAGE/SELECT but not UPDATE',
    coalesce((
      SELECT jsonb_agg(problem ORDER BY problem)::text
      FROM (
        SELECT sequence_name || ':missing USAGE' AS problem
        FROM unnest(ARRAY[
          'aido_project_activity_id_seq',
          'aido_project_deletion_audit_id_seq'
        ]) AS expected_sequence(sequence_name)
        WHERE NOT coalesce(has_sequence_privilege(
          'authenticated', to_regclass('public.' || sequence_name), 'USAGE'
        ), false)
        UNION ALL
        SELECT sequence_name || ':missing SELECT' AS problem
        FROM unnest(ARRAY[
          'aido_project_activity_id_seq',
          'aido_project_deletion_audit_id_seq'
        ]) AS expected_sequence(sequence_name)
        WHERE NOT coalesce(has_sequence_privilege(
          'authenticated', to_regclass('public.' || sequence_name), 'SELECT'
        ), false)
        UNION ALL
        SELECT sequence_name || ':unexpected UPDATE' AS problem
        FROM unnest(ARRAY[
          'aido_project_activity_id_seq',
          'aido_project_deletion_audit_id_seq'
        ]) AS expected_sequence(sequence_name)
        WHERE coalesce(has_sequence_privilege(
          'authenticated', to_regclass('public.' || sequence_name), 'UPDATE'
        ), false)
      ) sequence_problems
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM unnest(ARRAY[
        'aido_project_activity_id_seq',
        'aido_project_deletion_audit_id_seq'
      ]) AS expected_sequence(sequence_name)
      WHERE NOT coalesce(has_sequence_privilege(
              'authenticated', to_regclass('public.' || sequence_name), 'USAGE'
            ), false)
         OR NOT coalesce(has_sequence_privilege(
              'authenticated', to_regclass('public.' || sequence_name), 'SELECT'
            ), false)
         OR coalesce(has_sequence_privilege(
              'authenticated', to_regclass('public.' || sequence_name), 'UPDATE'
            ), false)
    )
  UNION ALL
  SELECT
    120,
    'Assignment bucket',
    'private, 25 MiB, exact approved MIME types',
    coalesce((
      SELECT jsonb_build_object(
        'public', bucket.public,
        'file_size_limit', bucket.file_size_limit,
        'allowed_mime_types', bucket.allowed_mime_types
      )::text
      FROM storage.buckets bucket
      WHERE bucket.id = 'aido-assignment-files'
    ), 'missing'),
    EXISTS (
      SELECT 1
      FROM storage.buckets bucket
      WHERE bucket.id = 'aido-assignment-files'
        AND bucket.public = false
        AND bucket.file_size_limit = 26214400
        AND bucket.allowed_mime_types = ARRAY[
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'image/png',
          'image/jpeg',
          'text/plain'
        ]::text[]
    )
  UNION ALL
  SELECT
    130,
    'Assignment Storage policies',
    'owner read/upload/delete policies exist',
    coalesce((
      SELECT jsonb_agg(policy_name ORDER BY policy_name)::text
      FROM expected_storage_policies expected
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_policies policy
        WHERE policy.schemaname = 'storage'
          AND policy.tablename = 'objects'
          AND policy.policyname = expected.policy_name
      )
    ), '[]'),
    NOT EXISTS (
      SELECT 1
      FROM expected_storage_policies expected
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_policies policy
        WHERE policy.schemaname = 'storage'
          AND policy.tablename = 'objects'
          AND policy.policyname = expected.policy_name
      )
    )
)
SELECT check_name, expected, actual, pass
FROM checks
ORDER BY check_order;
