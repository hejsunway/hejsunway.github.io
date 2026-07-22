BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(38);

SELECT has_table('public', 'aido_documents', 'logical documents exist');
SELECT has_table('public', 'aido_document_versions', 'document versions exist');
SELECT has_table('public', 'aido_ingestion_jobs', 'durable ingestion jobs exist');
SELECT has_table('public', 'aido_ingestion_attempts', 'ingestion attempts exist');
SELECT has_table('public', 'aido_ingestion_service_events', 'provider cost events exist');
SELECT has_table('public', 'aido_ingestion_job_events', 'append-only job events exist');
SELECT has_table('public', 'aido_parser_runs', 'parser runs exist');
SELECT has_table('public', 'aido_document_pages', 'anchored pages exist');
SELECT has_table('public', 'aido_document_sections', 'anchored sections exist');
SELECT has_table('public', 'aido_document_chunks', 'anchored chunks exist');
SELECT has_table('public', 'aido_extraction_runs', 'requirement extraction runs exist');
SELECT has_table('public', 'aido_requirement_sets', 'requirement sets exist');
SELECT has_table('public', 'aido_requirements', 'editable requirements exist');
SELECT has_table('public', 'aido_requirement_revisions', 'requirement revisions exist');
SELECT has_table('public', 'aido_requirement_confirmations', 'requirement confirmations exist');

SELECT ok(
  (
    SELECT bool_and(relrowsecurity)
    FROM pg_class
    WHERE oid = ANY (ARRAY[
      'public.aido_documents'::regclass,
      'public.aido_document_versions'::regclass,
      'public.aido_ingestion_jobs'::regclass,
      'public.aido_ingestion_attempts'::regclass,
      'public.aido_ingestion_service_events'::regclass,
      'public.aido_ingestion_job_events'::regclass,
      'public.aido_parser_runs'::regclass,
      'public.aido_document_pages'::regclass,
      'public.aido_document_sections'::regclass,
      'public.aido_document_chunks'::regclass,
      'public.aido_extraction_runs'::regclass,
      'public.aido_requirement_sets'::regclass,
      'public.aido_requirements'::regclass,
      'public.aido_requirement_revisions'::regclass,
      'public.aido_requirement_confirmations'::regclass
    ])
  ),
  'every Phase 3 content and job table has RLS enabled'
);

SELECT ok(
  (
    SELECT bool_and(NOT has_table_privilege('anon', object_name, privilege_name))
    FROM unnest(ARRAY[
      'public.aido_documents',
      'public.aido_document_versions',
      'public.aido_ingestion_jobs',
      'public.aido_ingestion_attempts',
      'public.aido_ingestion_service_events',
      'public.aido_ingestion_job_events',
      'public.aido_parser_runs',
      'public.aido_document_pages',
      'public.aido_document_sections',
      'public.aido_document_chunks',
      'public.aido_extraction_runs',
      'public.aido_requirement_sets',
      'public.aido_requirements',
      'public.aido_requirement_revisions',
      'public.aido_requirement_confirmations'
    ]) AS phase_three_table(object_name)
    CROSS JOIN unnest(ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]) AS table_privilege(privilege_name)
  ),
  'anonymous has no Phase 3 table privileges'
);

SELECT ok(
  (
    SELECT bool_and(has_table_privilege('authenticated', object_name, 'SELECT'))
    FROM unnest(ARRAY[
      'public.aido_documents',
      'public.aido_document_versions',
      'public.aido_ingestion_jobs',
      'public.aido_ingestion_attempts',
      'public.aido_ingestion_service_events',
      'public.aido_ingestion_job_events',
      'public.aido_parser_runs',
      'public.aido_document_pages',
      'public.aido_document_sections',
      'public.aido_document_chunks',
      'public.aido_extraction_runs',
      'public.aido_requirement_sets',
      'public.aido_requirements',
      'public.aido_requirement_revisions',
      'public.aido_requirement_confirmations'
    ]) AS phase_three_table(object_name)
  ),
  'authenticated users have the explicit Phase 3 read grants'
);

SELECT ok(
  (
    SELECT bool_and(NOT has_table_privilege('authenticated', object_name, privilege_name))
    FROM unnest(ARRAY[
      'public.aido_documents',
      'public.aido_document_versions',
      'public.aido_ingestion_jobs',
      'public.aido_ingestion_attempts',
      'public.aido_ingestion_service_events',
      'public.aido_ingestion_job_events',
      'public.aido_parser_runs',
      'public.aido_document_pages',
      'public.aido_document_sections',
      'public.aido_document_chunks',
      'public.aido_extraction_runs',
      'public.aido_requirement_sets',
      'public.aido_requirements',
      'public.aido_requirement_revisions',
      'public.aido_requirement_confirmations'
    ]) AS phase_three_table(object_name)
    CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
      AS table_privilege(privilege_name)
  ),
  'authenticated users cannot directly mutate worker-owned Phase 3 tables'
);

SELECT ok(
  (
    SELECT bool_and(
      has_table_privilege('service_role', object_name, 'SELECT')
      AND has_table_privilege('service_role', object_name, 'INSERT')
      AND NOT has_table_privilege('service_role', object_name, 'UPDATE')
      AND NOT has_table_privilege('service_role', object_name, 'DELETE')
    )
    FROM unnest(ARRAY[
      'public.aido_ingestion_service_events',
      'public.aido_ingestion_job_events',
      'public.aido_requirement_revisions',
      'public.aido_requirement_confirmations'
    ]) AS append_only_table(object_name)
  ),
  'service role has append-only privileges on historical evidence tables'
);

SELECT ok(
  NOT ('application/msword' = ANY (
    SELECT unnest(allowed_mime_types)
    FROM storage.buckets
    WHERE id = 'aido-assignment-files'
  )),
  'legacy binary DOC is removed from the Phase 3 upload contract'
);

INSERT INTO auth.users (id, email, is_sso_user, is_anonymous)
VALUES
  ('30000000-0000-4000-8000-000000000001', 'phase3-owner@example.test', false, false),
  ('30000000-0000-4000-8000-000000000002', 'phase3-other@example.test', false, false);

INSERT INTO public.aido_product_memberships (user_id, status, role)
VALUES
  ('30000000-0000-4000-8000-000000000001', 'active', 'student'),
  ('30000000-0000-4000-8000-000000000002', 'active', 'student');

INSERT INTO public.aido_writing_projects (
  id, owner_id, title, assignment_type, citation_style, integrity_mode, status
) VALUES
  ('30100000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Phase 3 owner project', 'Report', 'APA 7', 'planning_only', 'setup'),
  ('30100000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'Phase 3 other project', 'Essay', 'MLA 9', 'planning_only', 'setup');

INSERT INTO public.aido_project_policies (
  id, project_id, confirmed_by, integrity_mode, policy_text, is_confirmed, confirmed_at
) VALUES
  ('30200000-0000-4000-8000-000000000001', '30100000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'planning_only', 'Planning support is permitted.', true, now()),
  ('30200000-0000-4000-8000-000000000002', '30100000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'planning_only', 'Planning support is permitted.', true, now());

INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
VALUES
  (
    'aido-assignment-files',
    '30000000-0000-4000-8000-000000000001/30100000-0000-4000-8000-000000000001/brief.txt',
    '30000000-0000-4000-8000-000000000001',
    '{"size":100,"mimetype":"text/plain"}'::jsonb
  ),
  (
    'aido-assignment-files',
    '30000000-0000-4000-8000-000000000002/30100000-0000-4000-8000-000000000002/rubric.txt',
    '30000000-0000-4000-8000-000000000002',
    '{"size":120,"mimetype":"text/plain"}'::jsonb
  ),
  (
    'aido-assignment-files',
    '30000000-0000-4000-8000-000000000002/30100000-0000-4000-8000-000000000002/other.txt',
    '30000000-0000-4000-8000-000000000002',
    '{"size":130,"mimetype":"text/plain"}'::jsonb
  );

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
SELECT public.aido_register_assignment_document(
  '30100000-0000-4000-8000-000000000001',
  'brief',
  'brief.txt',
  '30000000-0000-4000-8000-000000000001/30100000-0000-4000-8000-000000000001/brief.txt',
  'text/plain',
  100,
  repeat('1', 64)
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
SET LOCAL ROLE authenticated;
SELECT public.aido_register_assignment_document(
  '30100000-0000-4000-8000-000000000002',
  'rubric',
  'rubric.txt',
  '30000000-0000-4000-8000-000000000002/30100000-0000-4000-8000-000000000002/rubric.txt',
  'text/plain',
  120,
  repeat('2', 64)
);
SELECT public.aido_register_assignment_document(
  '30100000-0000-4000-8000-000000000002',
  'other',
  'other.txt',
  '30000000-0000-4000-8000-000000000002/30100000-0000-4000-8000-000000000002/other.txt',
  'text/plain',
  130,
  repeat('3', 64)
);
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

INSERT INTO public.aido_documents (id, project_id, created_by, kind, display_name)
VALUES
  ('31000000-0000-4000-8000-000000000001', '30100000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'brief', 'brief.txt'),
  ('31000000-0000-4000-8000-000000000002', '30100000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'rubric', 'rubric.txt');

INSERT INTO public.aido_document_versions (
  id, document_id, project_id, assignment_document_id, version_number, uploaded_by,
  original_filename, storage_bucket, storage_path, declared_mime_type, detected_mime_type,
  size_bytes, sha256, page_count
) VALUES
  (
    '32000000-0000-4000-8000-000000000001',
    '31000000-0000-4000-8000-000000000001',
    '30100000-0000-4000-8000-000000000001',
    (SELECT id FROM public.aido_assignment_documents WHERE content_hash = repeat('1', 64)),
    1,
    '30000000-0000-4000-8000-000000000001',
    'brief.txt',
    'aido-assignment-files',
    '30000000-0000-4000-8000-000000000001/30100000-0000-4000-8000-000000000001/brief.txt',
    'text/plain',
    'text/plain',
    100,
    repeat('1', 64),
    1
  ),
  (
    '32000000-0000-4000-8000-000000000002',
    '31000000-0000-4000-8000-000000000002',
    '30100000-0000-4000-8000-000000000002',
    (SELECT id FROM public.aido_assignment_documents WHERE content_hash = repeat('2', 64)),
    1,
    '30000000-0000-4000-8000-000000000002',
    'rubric.txt',
    'aido-assignment-files',
    '30000000-0000-4000-8000-000000000002/30100000-0000-4000-8000-000000000002/rubric.txt',
    'text/plain',
    'text/plain',
    120,
    repeat('2', 64),
    1
  );

SELECT throws_ok(
  $$INSERT INTO public.aido_document_versions (
      id, document_id, project_id, assignment_document_id, version_number, uploaded_by,
      original_filename, storage_bucket, storage_path, declared_mime_type,
      size_bytes, sha256
    ) VALUES (
      '32000000-0000-4000-8000-000000000003',
      '31000000-0000-4000-8000-000000000001',
      '30100000-0000-4000-8000-000000000002',
      (SELECT id FROM public.aido_assignment_documents WHERE content_hash = repeat('3', 64)),
      2,
      '30000000-0000-4000-8000-000000000002',
      'cross-project.txt', 'aido-assignment-files',
      '30000000-0000-4000-8000-000000000002/30100000-0000-4000-8000-000000000002/other.txt',
      'text/plain', 130, repeat('4', 64)
    )$$,
  '23503',
  NULL,
  'document version cannot cross project ownership'
);

INSERT INTO public.aido_ingestion_jobs (
  id, project_id, document_version_id, requested_by, idempotency_key
) VALUES
  ('33000000-0000-4000-8000-000000000001', '30100000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'phase3-owner-job-0001'),
  ('33000000-0000-4000-8000-000000000002', '30100000-0000-4000-8000-000000000002', '32000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'phase3-other-job-0001');

SELECT throws_ok(
  $$INSERT INTO public.aido_ingestion_jobs (
      project_id, document_version_id, requested_by, idempotency_key
    ) VALUES (
      '30100000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      'phase3-owner-job-0001'
    )$$,
  '23505',
  NULL,
  'job idempotency key prevents duplicate enqueue state'
);

SELECT throws_ok(
  $$INSERT INTO public.aido_ingestion_jobs (
      project_id, document_version_id, requested_by, idempotency_key
    ) VALUES (
      '30100000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000001',
      'phase3-cross-project-job'
    )$$,
  '23503',
  NULL,
  'job cannot bind a document version from another project'
);

INSERT INTO public.aido_ingestion_attempts (
  id, job_id, document_version_id, attempt_number, worker_id, lease_token, lease_expires_at
) VALUES (
  '34000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000001',
  1,
  'phase3-worker-0001',
  '34000000-0000-4000-8000-000000000011',
  now() + interval '5 minutes'
);

SELECT throws_ok(
  $$INSERT INTO public.aido_ingestion_attempts (
      job_id, document_version_id, attempt_number, worker_id, lease_token, lease_expires_at
    ) VALUES (
      '33000000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000001',
      1,
      'phase3-worker-0002',
      '34000000-0000-4000-8000-000000000012',
      now() + interval '5 minutes'
    )$$,
  '23505',
  NULL,
  'attempt number is unique per durable job'
);

INSERT INTO public.aido_ingestion_service_events (
  project_id, job_id, attempt_id, document_version_id, service_kind, provider,
  operation, provider_request_id, idempotency_key, operation_units, cost_microusd, outcome
) VALUES (
  '30100000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000001',
  '34000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000001',
  'queue', 'vercel', 'send', 'queue-request-0001', 'phase3-queue-send-0001', 2, 1, 'succeeded'
);

SELECT throws_ok(
  $$INSERT INTO public.aido_ingestion_service_events (
      project_id, job_id, attempt_id, document_version_id, service_kind, provider,
      operation, provider_request_id, idempotency_key, outcome
    ) VALUES (
      '30100000-0000-4000-8000-000000000001',
      '33000000-0000-4000-8000-000000000001',
      '34000000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000001',
      'queue', 'vercel', 'send', 'queue-request-0002', 'phase3-queue-send-0001', 'succeeded'
    )$$,
  '23505',
  NULL,
  'service-event idempotency prevents duplicate provider cost evidence'
);

INSERT INTO public.aido_parser_runs (
  id, project_id, document_version_id, job_id, attempt_id, parser_kind,
  parser_version, input_sha256, configuration_sha256
) VALUES (
  '35000000-0000-4000-8000-000000000001',
  '30100000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000001',
  '34000000-0000-4000-8000-000000000001',
  'utf8_text', 'aido-text-v1', repeat('1', 64), repeat('a', 64)
);

INSERT INTO public.aido_document_pages (
  id, project_id, document_version_id, parser_run_id, page_number,
  text_content, text_sha256, confidence
) VALUES (
  '36000000-0000-4000-8000-000000000001',
  '30100000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000001',
  '35000000-0000-4000-8000-000000000001',
  1,
  'Evaluate the strengths and limitations of the selected approach.',
  repeat('b', 64),
  1
);

INSERT INTO public.aido_document_sections (
  id, project_id, document_version_id, parser_run_id, section_index, heading_path,
  title, start_page, end_page, start_character, end_character, text_content, text_sha256
) VALUES (
  '37000000-0000-4000-8000-000000000001',
  '30100000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000001',
  '35000000-0000-4000-8000-000000000001',
  0,
  ARRAY['Task'],
  'Task',
  1,
  1,
  0,
  64,
  'Evaluate the strengths and limitations of the selected approach.',
  repeat('c', 64)
);

INSERT INTO public.aido_document_chunks (
  id, project_id, document_version_id, parser_run_id, section_id, chunk_index,
  start_page, end_page, start_character, end_character, text_content, text_sha256, token_count
) VALUES (
  '38000000-0000-4000-8000-000000000001',
  '30100000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000001',
  '35000000-0000-4000-8000-000000000001',
  '37000000-0000-4000-8000-000000000001',
  0,
  1,
  1,
  0,
  64,
  'Evaluate the strengths and limitations of the selected approach.',
  repeat('d', 64),
  10
);

INSERT INTO public.aido_extraction_runs (
  id, project_id, document_version_id, job_id, attempt_id, parser_run_id,
  prompt_version, schema_version, input_sha256
) VALUES (
  '39000000-0000-4000-8000-000000000001',
  '30100000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000001',
  '34000000-0000-4000-8000-000000000001',
  '35000000-0000-4000-8000-000000000001',
  'requirements-v1', 'requirements-schema-v1', repeat('e', 64)
);

INSERT INTO public.aido_requirement_sets (
  id, project_id, document_version_id, extraction_run_id, status
) VALUES (
  '3a000000-0000-4000-8000-000000000001',
  '30100000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000001',
  '39000000-0000-4000-8000-000000000001',
  'awaiting_confirmation'
);

SELECT throws_ok(
  $$INSERT INTO public.aido_requirements (
      project_id, requirement_set_id, document_version_id, ordinal, kind, title,
      description, confidence, source_quote, source_page_id, source_section_id,
      source_chunk_id, anchor_start_character, anchor_end_character
    ) VALUES (
      '30100000-0000-4000-8000-000000000001',
      '3a000000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000001',
      0, 'analysis', 'Evaluate the approach', 'Evaluate strengths and limitations.',
      0.7, 'Evaluate the strengths and limitations',
      '36000000-0000-4000-8000-000000000001',
      '37000000-0000-4000-8000-000000000001',
      '38000000-0000-4000-8000-000000000001', 0, 43
    )$$,
  '23514',
  NULL,
  'low-confidence requirements must explain their uncertainty'
);

SELECT lives_ok(
  $$INSERT INTO public.aido_requirements (
      id, project_id, requirement_set_id, document_version_id, ordinal, kind, title,
      description, command_verb, confidence, uncertainty_reason, source_quote,
      source_page_id, source_section_id, source_chunk_id,
      anchor_start_character, anchor_end_character
    ) VALUES (
      '3b000000-0000-4000-8000-000000000001',
      '30100000-0000-4000-8000-000000000001',
      '3a000000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000001',
      0, 'analysis', 'Evaluate the approach', 'Evaluate strengths and limitations.',
      'Evaluate', 0.7, 'The brief does not define the selected approach.',
      'Evaluate the strengths and limitations',
      '36000000-0000-4000-8000-000000000001',
      '37000000-0000-4000-8000-000000000001',
      '38000000-0000-4000-8000-000000000001', 0, 43
    )$$,
  'valid anchored requirement persists with visible uncertainty'
);

SELECT throws_ok(
  $$INSERT INTO public.aido_requirements (
      project_id, requirement_set_id, document_version_id, ordinal, kind, title,
      description, confidence, source_quote, source_chunk_id,
      anchor_start_character, anchor_end_character
    ) VALUES (
      '30100000-0000-4000-8000-000000000001',
      '3a000000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000002',
      1, 'other', 'Invalid anchor', 'This must not persist.', 1,
      'not from this version', '38000000-0000-4000-8000-000000000001', 0, 10
    )$$,
  '23503',
  NULL,
  'requirement cannot use an anchor from another document version'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

SELECT is((SELECT count(*) FROM public.aido_documents), 1::bigint, 'owner sees only their logical document');
SELECT is((SELECT count(*) FROM public.aido_ingestion_jobs), 1::bigint, 'owner sees only their ingestion job');
SELECT is(
  (SELECT count(*) FROM public.aido_document_versions WHERE project_id = '30100000-0000-4000-8000-000000000002'),
  0::bigint,
  'owner cannot read another project document version'
);
SELECT throws_ok(
  $$INSERT INTO public.aido_documents (project_id, created_by, kind, display_name)
    VALUES ('30100000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'brief', 'blocked.txt')$$,
  '42501',
  NULL,
  'authenticated user cannot directly insert worker-owned rows'
);
SELECT throws_ok(
  $$UPDATE public.aido_ingestion_jobs SET status_version = status_version + 1
    WHERE id = '33000000-0000-4000-8000-000000000001'$$,
  '42501',
  NULL,
  'authenticated user cannot directly mutate job state'
);
SELECT throws_ok(
  $$INSERT INTO public.aido_ingestion_job_events (
      project_id, job_id, actor_kind, actor_user_id, event_type
    ) VALUES (
      '30100000-0000-4000-8000-000000000001',
      '33000000-0000-4000-8000-000000000001',
      'student', '30000000-0000-4000-8000-000000000001', 'job.fake_success'
    )$$,
  '42501',
  NULL,
  'browser role cannot fabricate append-only job evidence'
);

RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

SELECT ok(
  NOT has_sequence_privilege('authenticated', 'public.aido_ingestion_service_events_id_seq', 'USAGE')
  AND NOT has_sequence_privilege('authenticated', 'public.aido_ingestion_job_events_id_seq', 'USAGE')
  AND NOT has_sequence_privilege('authenticated', 'public.aido_requirement_revisions_id_seq', 'USAGE'),
  'authenticated users have no Phase 3 evidence-sequence privileges'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
SELECT is((SELECT count(*) FROM public.aido_documents), 1::bigint, 'other owner sees only their own logical document');
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

DELETE FROM public.aido_writing_projects WHERE id = '30100000-0000-4000-8000-000000000001';
SELECT is(
  (SELECT count(*) FROM public.aido_ingestion_jobs WHERE project_id = '30100000-0000-4000-8000-000000000001'),
  0::bigint,
  'project deletion cascades through the Phase 3 ingestion graph'
);

SELECT * FROM finish();
ROLLBACK;
