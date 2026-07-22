-- =============================================================================
-- Migration: AidoFor.me Phase 3.1 document ingestion and requirements schema
-- Date: 2026-07-22
--
-- Scope
--   - logical Aido documents and immutable uploaded document versions
--   - durable ingestion jobs, attempts, cost events, and append-only events
--   - versioned parser/OCR runs with anchored pages, sections, and chunks
--   - versioned extraction runs, editable requirements, revisions, confirmations
--   - owner-readable RLS and service-only worker mutation
--
-- The migration is intentionally ordered after the final canonical Phase 2
-- migration and before unrelated local humanizer migrations.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Domain enums
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aido_ingestion_status') THEN
    CREATE TYPE public.aido_ingestion_status AS ENUM (
      'queued',
      'validating',
      'scanning',
      'parsing',
      'ocr',
      'chunking',
      'extracting',
      'awaiting_confirmation',
      'retry_wait',
      'completed',
      'failed',
      'cancelled'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aido_ingestion_attempt_status') THEN
    CREATE TYPE public.aido_ingestion_attempt_status AS ENUM (
      'leased',
      'running',
      'succeeded',
      'retryable_failed',
      'terminal_failed',
      'cancelled',
      'lease_expired'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aido_parser_kind') THEN
    CREATE TYPE public.aido_parser_kind AS ENUM (
      'pdfjs',
      'mammoth',
      'utf8_text',
      'google_document_ai_ocr'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aido_run_status') THEN
    CREATE TYPE public.aido_run_status AS ENUM (
      'pending',
      'running',
      'succeeded',
      'failed',
      'cancelled'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aido_ingestion_service_kind') THEN
    CREATE TYPE public.aido_ingestion_service_kind AS ENUM (
      'queue',
      'malware_scan',
      'ocr',
      'requirement_extraction'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aido_ingestion_service_outcome') THEN
    CREATE TYPE public.aido_ingestion_service_outcome AS ENUM (
      'succeeded',
      'failed',
      'cancelled',
      'unsupported',
      'threat_found'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aido_requirement_set_status') THEN
    CREATE TYPE public.aido_requirement_set_status AS ENUM (
      'draft',
      'awaiting_confirmation',
      'confirmed',
      'superseded'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aido_requirement_kind') THEN
    CREATE TYPE public.aido_requirement_kind AS ENUM (
      'deliverable',
      'content',
      'analysis',
      'format',
      'citation',
      'source',
      'deadline',
      'word_count',
      'rubric',
      'policy',
      'other'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aido_requirement_status') THEN
    CREATE TYPE public.aido_requirement_status AS ENUM (
      'proposed',
      'edited',
      'confirmed',
      'rejected'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aido_event_actor_kind') THEN
    CREATE TYPE public.aido_event_actor_kind AS ENUM (
      'student',
      'worker',
      'system'
    );
  END IF;
END $$;

-- Project-policy snapshots are linked with their project so a confirmation
-- cannot point at another tenant's policy row.
ALTER TABLE public.aido_project_policies
  ADD CONSTRAINT aido_project_policies_id_project_unique UNIQUE (id, project_id);

-- ----------------------------------------------------------------------------
-- Logical documents and immutable uploaded versions
-- ----------------------------------------------------------------------------
CREATE TABLE public.aido_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  kind            public.aido_document_kind NOT NULL,
  display_name    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_documents_id_project_unique UNIQUE (id, project_id),
  CONSTRAINT aido_documents_display_name_length
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 255)
);

CREATE INDEX idx_aido_documents_project_kind_created
  ON public.aido_documents (project_id, kind, created_at DESC);
CREATE INDEX idx_aido_documents_created_by
  ON public.aido_documents (created_by);

CREATE TRIGGER aido_set_documents_v3_updated_at
  BEFORE UPDATE ON public.aido_documents
  FOR EACH ROW EXECUTE FUNCTION public.aido_set_updated_at();

CREATE TABLE public.aido_document_versions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id             uuid NOT NULL REFERENCES public.aido_documents(id) ON DELETE CASCADE,
  project_id              uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  assignment_document_id  uuid NOT NULL UNIQUE
                            REFERENCES public.aido_assignment_documents(id) ON DELETE CASCADE,
  version_number          integer NOT NULL,
  uploaded_by             uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  original_filename       text NOT NULL,
  storage_bucket          text NOT NULL,
  storage_path            text NOT NULL,
  declared_mime_type      text NOT NULL,
  detected_mime_type      text,
  size_bytes              bigint NOT NULL,
  sha256                  text NOT NULL,
  page_count              integer,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_document_versions_document_project_fkey
    FOREIGN KEY (document_id, project_id)
    REFERENCES public.aido_documents(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_document_versions_document_number_unique
    UNIQUE (document_id, version_number),
  CONSTRAINT aido_document_versions_document_hash_unique
    UNIQUE (document_id, sha256),
  CONSTRAINT aido_document_versions_id_document_unique
    UNIQUE (id, document_id),
  CONSTRAINT aido_document_versions_id_project_unique
    UNIQUE (id, project_id),
  CONSTRAINT aido_document_versions_filename_length
    CHECK (char_length(btrim(original_filename)) BETWEEN 1 AND 255),
  CONSTRAINT aido_document_versions_bucket
    CHECK (storage_bucket = 'aido-assignment-files'),
  CONSTRAINT aido_document_versions_path_length
    CHECK (char_length(storage_path) BETWEEN 5 AND 1024),
  CONSTRAINT aido_document_versions_mime
    CHECK (
      declared_mime_type IN (
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/png',
        'image/jpeg',
        'text/plain'
      )
      AND (
        detected_mime_type IS NULL
        OR detected_mime_type IN (
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'image/png',
          'image/jpeg',
          'text/plain'
        )
      )
    ),
  CONSTRAINT aido_document_versions_size CHECK (size_bytes BETWEEN 1 AND 26214400),
  CONSTRAINT aido_document_versions_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT aido_document_versions_page_count
    CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 200),
  CONSTRAINT aido_document_versions_version_number CHECK (version_number > 0)
);

CREATE INDEX idx_aido_document_versions_project_created
  ON public.aido_document_versions (project_id, created_at DESC);
CREATE INDEX idx_aido_document_versions_document_created
  ON public.aido_document_versions (document_id, version_number DESC);
CREATE INDEX idx_aido_document_versions_uploaded_by
  ON public.aido_document_versions (uploaded_by);

-- ----------------------------------------------------------------------------
-- Durable jobs, attempts, cost evidence, and append-only state events
-- ----------------------------------------------------------------------------
CREATE TABLE public.aido_ingestion_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  document_version_id   uuid NOT NULL,
  requested_by          uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key       text NOT NULL UNIQUE,
  status                public.aido_ingestion_status NOT NULL DEFAULT 'queued',
  status_version        integer NOT NULL DEFAULT 1,
  attempt_count         integer NOT NULL DEFAULT 0,
  max_attempts          integer NOT NULL DEFAULT 5,
  current_stage_started_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at       timestamptz,
  lease_owner           text,
  lease_token           uuid,
  lease_expires_at      timestamptz,
  cancellation_requested_at timestamptz,
  cancellation_requested_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  failure_code          text,
  failure_detail        text,
  usage_reservation_id  uuid REFERENCES public.aido_usage_reservations(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  completed_at          timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_ingestion_jobs_version_project_fkey
    FOREIGN KEY (document_version_id, project_id)
    REFERENCES public.aido_document_versions(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_ingestion_jobs_id_version_unique
    UNIQUE (id, document_version_id),
  CONSTRAINT aido_ingestion_jobs_id_project_unique
    UNIQUE (id, project_id),
  CONSTRAINT aido_ingestion_jobs_key
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  CONSTRAINT aido_ingestion_jobs_versions
    CHECK (status_version > 0 AND attempt_count >= 0 AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT aido_ingestion_jobs_lease_consistency
    CHECK (
      (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      OR (
        lease_owner IS NOT NULL
        AND char_length(btrim(lease_owner)) BETWEEN 8 AND 200
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
    ),
  CONSTRAINT aido_ingestion_jobs_retry_consistency
    CHECK ((status = 'retry_wait') = (next_attempt_at IS NOT NULL)),
  CONSTRAINT aido_ingestion_jobs_cancel_consistency
    CHECK (
      (cancellation_requested_at IS NULL AND cancellation_requested_by IS NULL)
      OR (cancellation_requested_at IS NOT NULL AND cancellation_requested_by IS NOT NULL)
    ),
  CONSTRAINT aido_ingestion_jobs_failure_consistency
    CHECK (
      (status = 'failed' AND failure_code IS NOT NULL)
      OR (status <> 'failed' AND failure_code IS NULL AND failure_detail IS NULL)
    ),
  CONSTRAINT aido_ingestion_jobs_terminal_consistency
    CHECK (
      (status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL)
      OR (status NOT IN ('completed', 'failed', 'cancelled') AND completed_at IS NULL)
    ),
  CONSTRAINT aido_ingestion_jobs_failure_lengths
    CHECK (
      (failure_code IS NULL OR char_length(failure_code) BETWEEN 3 AND 80)
      AND (failure_detail IS NULL OR char_length(failure_detail) <= 1000)
    )
);

CREATE INDEX idx_aido_ingestion_jobs_project_created
  ON public.aido_ingestion_jobs (project_id, created_at DESC);
CREATE INDEX idx_aido_ingestion_jobs_document_version
  ON public.aido_ingestion_jobs (document_version_id, created_at DESC);
CREATE INDEX idx_aido_ingestion_jobs_requested_by
  ON public.aido_ingestion_jobs (requested_by, created_at DESC);
CREATE INDEX idx_aido_ingestion_jobs_runnable
  ON public.aido_ingestion_jobs (next_attempt_at, created_at)
  WHERE status IN ('queued', 'retry_wait');
CREATE INDEX idx_aido_ingestion_jobs_expired_lease
  ON public.aido_ingestion_jobs (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;
CREATE INDEX idx_aido_ingestion_jobs_reservation
  ON public.aido_ingestion_jobs (usage_reservation_id)
  WHERE usage_reservation_id IS NOT NULL;

CREATE TRIGGER aido_set_ingestion_jobs_updated_at
  BEFORE UPDATE ON public.aido_ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION public.aido_set_updated_at();

CREATE TABLE public.aido_ingestion_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES public.aido_ingestion_jobs(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL,
  attempt_number    integer NOT NULL,
  status            public.aido_ingestion_attempt_status NOT NULL DEFAULT 'leased',
  worker_id         text NOT NULL,
  lease_token       uuid NOT NULL UNIQUE,
  lease_expires_at  timestamptz NOT NULL,
  heartbeat_at      timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  error_code        text,
  retryable         boolean,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_ingestion_attempts_job_version_fkey
    FOREIGN KEY (job_id, document_version_id)
    REFERENCES public.aido_ingestion_jobs(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_ingestion_attempts_job_number_unique UNIQUE (job_id, attempt_number),
  CONSTRAINT aido_ingestion_attempts_id_job_unique UNIQUE (id, job_id),
  CONSTRAINT aido_ingestion_attempts_number CHECK (attempt_number BETWEEN 1 AND 20),
  CONSTRAINT aido_ingestion_attempts_worker
    CHECK (char_length(btrim(worker_id)) BETWEEN 8 AND 200),
  CONSTRAINT aido_ingestion_attempts_lease
    CHECK (lease_expires_at > started_at AND heartbeat_at >= started_at),
  CONSTRAINT aido_ingestion_attempts_terminal
    CHECK (
      (status IN ('succeeded', 'retryable_failed', 'terminal_failed', 'cancelled', 'lease_expired') AND ended_at IS NOT NULL)
      OR (status IN ('leased', 'running') AND ended_at IS NULL)
    ),
  CONSTRAINT aido_ingestion_attempts_error
    CHECK (
      (status IN ('retryable_failed', 'terminal_failed', 'lease_expired') AND error_code IS NOT NULL)
      OR (status NOT IN ('retryable_failed', 'terminal_failed', 'lease_expired') AND error_code IS NULL)
    ),
  CONSTRAINT aido_ingestion_attempts_retryable
    CHECK (
      (status = 'retryable_failed' AND retryable = true)
      OR (status IN ('terminal_failed', 'lease_expired') AND retryable IS NOT NULL)
      OR (status NOT IN ('retryable_failed', 'terminal_failed', 'lease_expired') AND retryable IS NULL)
    ),
  CONSTRAINT aido_ingestion_attempts_error_length
    CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 3 AND 80)
);

CREATE INDEX idx_aido_ingestion_attempts_job_created
  ON public.aido_ingestion_attempts (job_id, created_at DESC);
CREATE INDEX idx_aido_ingestion_attempts_document_version
  ON public.aido_ingestion_attempts (document_version_id, created_at DESC);
CREATE INDEX idx_aido_ingestion_attempts_active_lease
  ON public.aido_ingestion_attempts (lease_expires_at)
  WHERE status IN ('leased', 'running');

CREATE TABLE public.aido_ingestion_service_events (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id            uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  job_id                uuid NOT NULL,
  attempt_id            uuid,
  document_version_id   uuid NOT NULL,
  service_kind          public.aido_ingestion_service_kind NOT NULL,
  provider              text NOT NULL,
  operation             text NOT NULL,
  provider_request_id   text,
  idempotency_key       text NOT NULL UNIQUE,
  provider_version      text,
  input_bytes           bigint NOT NULL DEFAULT 0,
  processed_pages       integer NOT NULL DEFAULT 0,
  operation_units       bigint NOT NULL DEFAULT 0,
  cost_microusd         bigint NOT NULL DEFAULT 0,
  outcome               public.aido_ingestion_service_outcome NOT NULL,
  failure_code          text,
  response_sha256       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_ingestion_service_events_job_project_fkey
    FOREIGN KEY (job_id, project_id)
    REFERENCES public.aido_ingestion_jobs(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_ingestion_service_events_job_version_fkey
    FOREIGN KEY (job_id, document_version_id)
    REFERENCES public.aido_ingestion_jobs(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_ingestion_service_events_attempt_job_fkey
    FOREIGN KEY (attempt_id, job_id)
    REFERENCES public.aido_ingestion_attempts(id, job_id) ON DELETE CASCADE,
  CONSTRAINT aido_ingestion_service_events_provider_request_unique
    UNIQUE (provider, provider_request_id),
  CONSTRAINT aido_ingestion_service_events_key
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  CONSTRAINT aido_ingestion_service_events_names
    CHECK (
      char_length(btrim(provider)) BETWEEN 1 AND 80
      AND char_length(btrim(operation)) BETWEEN 1 AND 120
      AND (provider_version IS NULL OR char_length(provider_version) <= 160)
    ),
  CONSTRAINT aido_ingestion_service_events_values
    CHECK (input_bytes >= 0 AND processed_pages >= 0 AND operation_units >= 0 AND cost_microusd >= 0),
  CONSTRAINT aido_ingestion_service_events_failure
    CHECK (
      (outcome = 'succeeded' AND failure_code IS NULL)
      OR (outcome <> 'succeeded' AND failure_code IS NOT NULL)
    ),
  CONSTRAINT aido_ingestion_service_events_hash
    CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_aido_ingestion_service_events_project_created
  ON public.aido_ingestion_service_events (project_id, created_at DESC);
CREATE INDEX idx_aido_ingestion_service_events_job_created
  ON public.aido_ingestion_service_events (job_id, created_at);
CREATE INDEX idx_aido_ingestion_service_events_attempt
  ON public.aido_ingestion_service_events (attempt_id, created_at)
  WHERE attempt_id IS NOT NULL;
CREATE INDEX idx_aido_ingestion_service_events_document
  ON public.aido_ingestion_service_events (document_version_id, created_at);
CREATE INDEX idx_aido_ingestion_service_events_cost
  ON public.aido_ingestion_service_events (created_at, provider, service_kind);

CREATE TABLE public.aido_ingestion_job_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  job_id          uuid NOT NULL,
  attempt_id      uuid,
  actor_kind      public.aido_event_actor_kind NOT NULL,
  actor_user_id   uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  event_type      text NOT NULL,
  from_status     public.aido_ingestion_status,
  to_status       public.aido_ingestion_status,
  event_code      text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_ingestion_job_events_job_project_fkey
    FOREIGN KEY (job_id, project_id)
    REFERENCES public.aido_ingestion_jobs(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_ingestion_job_events_attempt_job_fkey
    FOREIGN KEY (attempt_id, job_id)
    REFERENCES public.aido_ingestion_attempts(id, job_id) ON DELETE CASCADE,
  CONSTRAINT aido_ingestion_job_events_actor
    CHECK (
      (actor_kind = 'student' AND actor_user_id IS NOT NULL)
      OR (actor_kind IN ('worker', 'system') AND actor_user_id IS NULL)
    ),
  CONSTRAINT aido_ingestion_job_events_type
    CHECK (char_length(btrim(event_type)) BETWEEN 3 AND 80),
  CONSTRAINT aido_ingestion_job_events_code
    CHECK (event_code IS NULL OR char_length(event_code) BETWEEN 3 AND 80),
  CONSTRAINT aido_ingestion_job_events_metadata
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_aido_ingestion_job_events_job_created
  ON public.aido_ingestion_job_events (job_id, created_at, id);
CREATE INDEX idx_aido_ingestion_job_events_project_created
  ON public.aido_ingestion_job_events (project_id, created_at DESC);
CREATE INDEX idx_aido_ingestion_job_events_attempt
  ON public.aido_ingestion_job_events (attempt_id, created_at)
  WHERE attempt_id IS NOT NULL;
CREATE INDEX idx_aido_ingestion_job_events_actor_user
  ON public.aido_ingestion_job_events (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Parser/OCR runs and durable anchors
-- ----------------------------------------------------------------------------
CREATE TABLE public.aido_parser_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  document_version_id   uuid NOT NULL,
  job_id                uuid NOT NULL,
  attempt_id            uuid NOT NULL,
  parser_kind           public.aido_parser_kind NOT NULL,
  parser_version        text NOT NULL,
  input_sha256          text NOT NULL,
  configuration_sha256  text NOT NULL,
  output_sha256         text,
  status                public.aido_run_status NOT NULL DEFAULT 'pending',
  page_count            integer,
  character_count       bigint,
  low_confidence_pages  integer NOT NULL DEFAULT 0,
  failure_code          text,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_parser_runs_job_version_fkey
    FOREIGN KEY (job_id, document_version_id)
    REFERENCES public.aido_ingestion_jobs(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_parser_runs_job_project_fkey
    FOREIGN KEY (job_id, project_id)
    REFERENCES public.aido_ingestion_jobs(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_parser_runs_attempt_job_fkey
    FOREIGN KEY (attempt_id, job_id)
    REFERENCES public.aido_ingestion_attempts(id, job_id) ON DELETE CASCADE,
  CONSTRAINT aido_parser_runs_version_identity_unique
    UNIQUE (document_version_id, parser_kind, parser_version, input_sha256, configuration_sha256),
  CONSTRAINT aido_parser_runs_id_version_unique UNIQUE (id, document_version_id),
  CONSTRAINT aido_parser_runs_id_project_unique UNIQUE (id, project_id),
  CONSTRAINT aido_parser_runs_versions
    CHECK (char_length(btrim(parser_version)) BETWEEN 1 AND 160),
  CONSTRAINT aido_parser_runs_hashes
    CHECK (
      input_sha256 ~ '^[0-9a-f]{64}$'
      AND configuration_sha256 ~ '^[0-9a-f]{64}$'
      AND (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT aido_parser_runs_counts
    CHECK (
      (page_count IS NULL OR page_count BETWEEN 1 AND 200)
      AND (character_count IS NULL OR character_count BETWEEN 0 AND 100000000)
      AND low_confidence_pages >= 0
      AND (page_count IS NULL OR low_confidence_pages <= page_count)
    ),
  CONSTRAINT aido_parser_runs_status
    CHECK (
      (status = 'pending' AND started_at IS NULL AND completed_at IS NULL AND failure_code IS NULL)
      OR (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL AND failure_code IS NULL)
      OR (status = 'succeeded' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND output_sha256 IS NOT NULL AND failure_code IS NULL)
      OR (status IN ('failed', 'cancelled') AND started_at IS NOT NULL AND completed_at IS NOT NULL)
    ),
  CONSTRAINT aido_parser_runs_failure
    CHECK (
      (status = 'failed' AND failure_code IS NOT NULL)
      OR (status <> 'failed' AND failure_code IS NULL)
    )
);

CREATE INDEX idx_aido_parser_runs_project_created
  ON public.aido_parser_runs (project_id, created_at DESC);
CREATE INDEX idx_aido_parser_runs_job_created
  ON public.aido_parser_runs (job_id, created_at);
CREATE INDEX idx_aido_parser_runs_attempt
  ON public.aido_parser_runs (attempt_id);

CREATE TABLE public.aido_document_pages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  document_version_id   uuid NOT NULL,
  parser_run_id         uuid NOT NULL,
  page_number           integer NOT NULL,
  width                 numeric,
  height                numeric,
  dimension_unit        text,
  text_content          text NOT NULL,
  text_sha256           text NOT NULL,
  confidence            numeric(6,5),
  review_required       boolean NOT NULL DEFAULT false,
  quality_signals       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_document_pages_parser_version_fkey
    FOREIGN KEY (parser_run_id, document_version_id)
    REFERENCES public.aido_parser_runs(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_document_pages_parser_project_fkey
    FOREIGN KEY (parser_run_id, project_id)
    REFERENCES public.aido_parser_runs(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_document_pages_parser_page_unique UNIQUE (parser_run_id, page_number),
  CONSTRAINT aido_document_pages_id_version_unique UNIQUE (id, document_version_id),
  CONSTRAINT aido_document_pages_page CHECK (page_number BETWEEN 1 AND 200),
  CONSTRAINT aido_document_pages_dimensions
    CHECK (
      (width IS NULL AND height IS NULL AND dimension_unit IS NULL)
      OR (width > 0 AND height > 0 AND char_length(dimension_unit) BETWEEN 1 AND 16)
    ),
  CONSTRAINT aido_document_pages_text CHECK (char_length(text_content) <= 5000000),
  CONSTRAINT aido_document_pages_hash CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT aido_document_pages_confidence CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT aido_document_pages_quality CHECK (jsonb_typeof(quality_signals) = 'object')
);

CREATE INDEX idx_aido_document_pages_project_version_page
  ON public.aido_document_pages (project_id, document_version_id, page_number);
CREATE INDEX idx_aido_document_pages_parser
  ON public.aido_document_pages (parser_run_id, page_number);
CREATE INDEX idx_aido_document_pages_review
  ON public.aido_document_pages (document_version_id, page_number)
  WHERE review_required;

CREATE TABLE public.aido_document_sections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  document_version_id   uuid NOT NULL,
  parser_run_id         uuid NOT NULL,
  section_index         integer NOT NULL,
  heading_path          text[] NOT NULL DEFAULT '{}',
  title                 text,
  start_page            integer,
  end_page              integer,
  start_character       bigint,
  end_character         bigint,
  text_content          text NOT NULL,
  text_sha256           text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_document_sections_parser_version_fkey
    FOREIGN KEY (parser_run_id, document_version_id)
    REFERENCES public.aido_parser_runs(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_document_sections_parser_project_fkey
    FOREIGN KEY (parser_run_id, project_id)
    REFERENCES public.aido_parser_runs(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_document_sections_id_project_unique UNIQUE (id, project_id),
  CONSTRAINT aido_document_sections_parser_index_unique UNIQUE (parser_run_id, section_index),
  CONSTRAINT aido_document_sections_id_version_unique UNIQUE (id, document_version_id),
  CONSTRAINT aido_document_sections_index CHECK (section_index >= 0),
  CONSTRAINT aido_document_sections_title
    CHECK (title IS NULL OR char_length(title) <= 500),
  CONSTRAINT aido_document_sections_pages
    CHECK (
      (start_page IS NULL AND end_page IS NULL)
      OR (start_page BETWEEN 1 AND 200 AND end_page BETWEEN start_page AND 200)
    ),
  CONSTRAINT aido_document_sections_characters
    CHECK (
      (start_character IS NULL AND end_character IS NULL)
      OR (start_character >= 0 AND end_character > start_character)
    ),
  CONSTRAINT aido_document_sections_text CHECK (char_length(text_content) <= 10000000),
  CONSTRAINT aido_document_sections_hash CHECK (text_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_aido_document_sections_project_version_index
  ON public.aido_document_sections (project_id, document_version_id, section_index);
CREATE INDEX idx_aido_document_sections_parser
  ON public.aido_document_sections (parser_run_id, section_index);

CREATE TABLE public.aido_document_chunks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  document_version_id   uuid NOT NULL,
  parser_run_id         uuid NOT NULL,
  section_id            uuid,
  chunk_index           integer NOT NULL,
  start_page            integer,
  end_page              integer,
  start_character       bigint NOT NULL,
  end_character         bigint NOT NULL,
  text_content          text NOT NULL,
  text_sha256           text NOT NULL,
  token_count           integer NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_document_chunks_parser_version_fkey
    FOREIGN KEY (parser_run_id, document_version_id)
    REFERENCES public.aido_parser_runs(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_document_chunks_parser_project_fkey
    FOREIGN KEY (parser_run_id, project_id)
    REFERENCES public.aido_parser_runs(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_document_chunks_section_version_fkey
    FOREIGN KEY (section_id, document_version_id)
    REFERENCES public.aido_document_sections(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_document_chunks_section_project_fkey
    FOREIGN KEY (section_id, project_id)
    REFERENCES public.aido_document_sections(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_document_chunks_parser_index_unique UNIQUE (parser_run_id, chunk_index),
  CONSTRAINT aido_document_chunks_id_version_unique UNIQUE (id, document_version_id),
  CONSTRAINT aido_document_chunks_index CHECK (chunk_index >= 0),
  CONSTRAINT aido_document_chunks_pages
    CHECK (
      (start_page IS NULL AND end_page IS NULL)
      OR (start_page BETWEEN 1 AND 200 AND end_page BETWEEN start_page AND 200)
    ),
  CONSTRAINT aido_document_chunks_characters
    CHECK (start_character >= 0 AND end_character > start_character),
  CONSTRAINT aido_document_chunks_text
    CHECK (char_length(text_content) BETWEEN 1 AND 50000),
  CONSTRAINT aido_document_chunks_hash CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT aido_document_chunks_tokens CHECK (token_count BETWEEN 1 AND 50000)
);

CREATE INDEX idx_aido_document_chunks_project_version_index
  ON public.aido_document_chunks (project_id, document_version_id, chunk_index);
CREATE INDEX idx_aido_document_chunks_parser
  ON public.aido_document_chunks (parser_run_id, chunk_index);
CREATE INDEX idx_aido_document_chunks_section
  ON public.aido_document_chunks (section_id, chunk_index)
  WHERE section_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Requirement extraction, editable rows, append-only revisions/confirmations
-- ----------------------------------------------------------------------------
CREATE TABLE public.aido_extraction_runs (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                      uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  document_version_id             uuid NOT NULL,
  job_id                          uuid NOT NULL,
  attempt_id                      uuid NOT NULL,
  parser_run_id                   uuid NOT NULL,
  status                          public.aido_run_status NOT NULL DEFAULT 'pending',
  prompt_version                  text NOT NULL,
  schema_version                  text NOT NULL,
  input_sha256                    text NOT NULL,
  output_sha256                   text,
  usage_reservation_id            uuid REFERENCES public.aido_usage_reservations(id) ON DELETE RESTRICT,
  provider_call_authorization_id  uuid REFERENCES public.aido_provider_call_authorizations(id) ON DELETE RESTRICT,
  usage_event_id                  bigint REFERENCES public.aido_usage_events(id) ON DELETE RESTRICT,
  validation_error_count          integer NOT NULL DEFAULT 0,
  failure_code                    text,
  started_at                      timestamptz,
  completed_at                    timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_extraction_runs_job_version_fkey
    FOREIGN KEY (job_id, document_version_id)
    REFERENCES public.aido_ingestion_jobs(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_extraction_runs_job_project_fkey
    FOREIGN KEY (job_id, project_id)
    REFERENCES public.aido_ingestion_jobs(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_extraction_runs_attempt_job_fkey
    FOREIGN KEY (attempt_id, job_id)
    REFERENCES public.aido_ingestion_attempts(id, job_id) ON DELETE CASCADE,
  CONSTRAINT aido_extraction_runs_parser_version_fkey
    FOREIGN KEY (parser_run_id, document_version_id)
    REFERENCES public.aido_parser_runs(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_extraction_runs_parser_project_fkey
    FOREIGN KEY (parser_run_id, project_id)
    REFERENCES public.aido_parser_runs(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_extraction_runs_identity_unique
    UNIQUE (document_version_id, prompt_version, schema_version, input_sha256),
  CONSTRAINT aido_extraction_runs_authorization_unique UNIQUE (provider_call_authorization_id),
  CONSTRAINT aido_extraction_runs_usage_event_unique UNIQUE (usage_event_id),
  CONSTRAINT aido_extraction_runs_id_version_unique UNIQUE (id, document_version_id),
  CONSTRAINT aido_extraction_runs_id_project_unique UNIQUE (id, project_id),
  CONSTRAINT aido_extraction_runs_names
    CHECK (
      char_length(btrim(prompt_version)) BETWEEN 1 AND 160
      AND char_length(btrim(schema_version)) BETWEEN 1 AND 160
    ),
  CONSTRAINT aido_extraction_runs_hashes
    CHECK (
      input_sha256 ~ '^[0-9a-f]{64}$'
      AND (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT aido_extraction_runs_validation CHECK (validation_error_count >= 0),
  CONSTRAINT aido_extraction_runs_status
    CHECK (
      (status = 'pending' AND started_at IS NULL AND completed_at IS NULL AND failure_code IS NULL)
      OR (
        status = 'running'
        AND started_at IS NOT NULL
        AND completed_at IS NULL
        AND failure_code IS NULL
        AND usage_reservation_id IS NOT NULL
        AND provider_call_authorization_id IS NOT NULL
      )
      OR (
        status = 'succeeded'
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND output_sha256 IS NOT NULL
        AND usage_reservation_id IS NOT NULL
        AND provider_call_authorization_id IS NOT NULL
        AND usage_event_id IS NOT NULL
        AND validation_error_count = 0
        AND failure_code IS NULL
      )
      OR (status IN ('failed', 'cancelled') AND started_at IS NOT NULL AND completed_at IS NOT NULL)
    ),
  CONSTRAINT aido_extraction_runs_failure
    CHECK (
      (status = 'failed' AND failure_code IS NOT NULL)
      OR (status <> 'failed' AND failure_code IS NULL)
    )
);

CREATE INDEX idx_aido_extraction_runs_project_created
  ON public.aido_extraction_runs (project_id, created_at DESC);
CREATE INDEX idx_aido_extraction_runs_job
  ON public.aido_extraction_runs (job_id, created_at);
CREATE INDEX idx_aido_extraction_runs_attempt
  ON public.aido_extraction_runs (attempt_id);
CREATE INDEX idx_aido_extraction_runs_parser
  ON public.aido_extraction_runs (parser_run_id);
CREATE INDEX idx_aido_extraction_runs_reservation
  ON public.aido_extraction_runs (usage_reservation_id)
  WHERE usage_reservation_id IS NOT NULL;

CREATE TABLE public.aido_requirement_sets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  document_version_id   uuid NOT NULL,
  extraction_run_id     uuid NOT NULL,
  status                public.aido_requirement_set_status NOT NULL DEFAULT 'draft',
  revision_number       integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_requirement_sets_extraction_version_fkey
    FOREIGN KEY (extraction_run_id, document_version_id)
    REFERENCES public.aido_extraction_runs(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirement_sets_extraction_project_fkey
    FOREIGN KEY (extraction_run_id, project_id)
    REFERENCES public.aido_extraction_runs(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirement_sets_extraction_unique UNIQUE (extraction_run_id),
  CONSTRAINT aido_requirement_sets_id_version_unique UNIQUE (id, document_version_id),
  CONSTRAINT aido_requirement_sets_id_project_unique UNIQUE (id, project_id),
  CONSTRAINT aido_requirement_sets_revision CHECK (revision_number > 0)
);

CREATE INDEX idx_aido_requirement_sets_project_created
  ON public.aido_requirement_sets (project_id, created_at DESC);
CREATE INDEX idx_aido_requirement_sets_document_status
  ON public.aido_requirement_sets (document_version_id, status, created_at DESC);

CREATE TRIGGER aido_set_requirement_sets_updated_at
  BEFORE UPDATE ON public.aido_requirement_sets
  FOR EACH ROW EXECUTE FUNCTION public.aido_set_updated_at();

CREATE TABLE public.aido_requirements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  requirement_set_id    uuid NOT NULL,
  document_version_id   uuid NOT NULL,
  ordinal               integer NOT NULL,
  kind                  public.aido_requirement_kind NOT NULL,
  status                public.aido_requirement_status NOT NULL DEFAULT 'proposed',
  title                 text NOT NULL,
  description           text NOT NULL,
  command_verb          text,
  weight_percent        numeric(7,4),
  confidence            numeric(6,5) NOT NULL,
  uncertainty_reason    text,
  source_quote          text NOT NULL,
  source_page_id        uuid,
  source_section_id     uuid,
  source_chunk_id       uuid NOT NULL,
  anchor_start_character bigint NOT NULL,
  anchor_end_character   bigint NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_requirements_set_version_fkey
    FOREIGN KEY (requirement_set_id, document_version_id)
    REFERENCES public.aido_requirement_sets(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirements_set_project_fkey
    FOREIGN KEY (requirement_set_id, project_id)
    REFERENCES public.aido_requirement_sets(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirements_id_project_unique UNIQUE (id, project_id),
  CONSTRAINT aido_requirements_page_version_fkey
    FOREIGN KEY (source_page_id, document_version_id)
    REFERENCES public.aido_document_pages(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirements_section_version_fkey
    FOREIGN KEY (source_section_id, document_version_id)
    REFERENCES public.aido_document_sections(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirements_chunk_version_fkey
    FOREIGN KEY (source_chunk_id, document_version_id)
    REFERENCES public.aido_document_chunks(id, document_version_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirements_set_ordinal_unique UNIQUE (requirement_set_id, ordinal),
  CONSTRAINT aido_requirements_ordinal CHECK (ordinal >= 0),
  CONSTRAINT aido_requirements_title
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 500),
  CONSTRAINT aido_requirements_description
    CHECK (char_length(btrim(description)) BETWEEN 1 AND 10000),
  CONSTRAINT aido_requirements_command
    CHECK (command_verb IS NULL OR char_length(command_verb) <= 120),
  CONSTRAINT aido_requirements_weight
    CHECK (weight_percent IS NULL OR weight_percent BETWEEN 0 AND 100),
  CONSTRAINT aido_requirements_confidence CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT aido_requirements_uncertainty
    CHECK (
      (confidence < 0.8 AND uncertainty_reason IS NOT NULL)
      OR confidence >= 0.8
    ),
  CONSTRAINT aido_requirements_uncertainty_length
    CHECK (uncertainty_reason IS NULL OR char_length(uncertainty_reason) <= 1000),
  CONSTRAINT aido_requirements_quote
    CHECK (char_length(btrim(source_quote)) BETWEEN 1 AND 4000),
  CONSTRAINT aido_requirements_anchor
    CHECK (anchor_start_character >= 0 AND anchor_end_character > anchor_start_character)
);

CREATE INDEX idx_aido_requirements_project_set_ordinal
  ON public.aido_requirements (project_id, requirement_set_id, ordinal);
CREATE INDEX idx_aido_requirements_document
  ON public.aido_requirements (document_version_id, ordinal);
CREATE INDEX idx_aido_requirements_page
  ON public.aido_requirements (source_page_id)
  WHERE source_page_id IS NOT NULL;
CREATE INDEX idx_aido_requirements_section
  ON public.aido_requirements (source_section_id)
  WHERE source_section_id IS NOT NULL;
CREATE INDEX idx_aido_requirements_chunk
  ON public.aido_requirements (source_chunk_id);
CREATE INDEX idx_aido_requirements_review
  ON public.aido_requirements (requirement_set_id, confidence, ordinal)
  WHERE status IN ('proposed', 'edited');

CREATE TRIGGER aido_set_requirements_updated_at
  BEFORE UPDATE ON public.aido_requirements
  FOR EACH ROW EXECUTE FUNCTION public.aido_set_updated_at();

CREATE TABLE public.aido_requirement_revisions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id          uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  requirement_id      uuid NOT NULL REFERENCES public.aido_requirements(id) ON DELETE CASCADE,
  requirement_set_id  uuid NOT NULL REFERENCES public.aido_requirement_sets(id) ON DELETE CASCADE,
  revision_number     integer NOT NULL,
  actor_kind          public.aido_event_actor_kind NOT NULL,
  actor_user_id       uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  snapshot            jsonb NOT NULL,
  change_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_requirement_revisions_requirement_number_unique
    UNIQUE (requirement_id, revision_number),
  CONSTRAINT aido_requirement_revisions_requirement_project_fkey
    FOREIGN KEY (requirement_id, project_id)
    REFERENCES public.aido_requirements(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirement_revisions_set_project_fkey
    FOREIGN KEY (requirement_set_id, project_id)
    REFERENCES public.aido_requirement_sets(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirement_revisions_actor
    CHECK (
      (actor_kind = 'student' AND actor_user_id IS NOT NULL)
      OR (actor_kind IN ('worker', 'system') AND actor_user_id IS NULL)
    ),
  CONSTRAINT aido_requirement_revisions_number CHECK (revision_number > 0),
  CONSTRAINT aido_requirement_revisions_snapshot CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT aido_requirement_revisions_reason
    CHECK (change_reason IS NULL OR char_length(change_reason) <= 1000)
);

CREATE INDEX idx_aido_requirement_revisions_project_created
  ON public.aido_requirement_revisions (project_id, created_at DESC);
CREATE INDEX idx_aido_requirement_revisions_set_created
  ON public.aido_requirement_revisions (requirement_set_id, created_at, id);
CREATE INDEX idx_aido_requirement_revisions_actor
  ON public.aido_requirement_revisions (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE TABLE public.aido_requirement_confirmations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES public.aido_writing_projects(id) ON DELETE CASCADE,
  requirement_set_id    uuid NOT NULL REFERENCES public.aido_requirement_sets(id) ON DELETE CASCADE,
  set_revision_number   integer NOT NULL,
  confirmed_by          uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  project_policy_id     uuid NOT NULL REFERENCES public.aido_project_policies(id) ON DELETE RESTRICT,
  policy_updated_at     timestamptz NOT NULL,
  integrity_mode        public.aido_integrity_mode NOT NULL,
  confirmed_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_requirement_confirmations_set_revision_unique
    UNIQUE (requirement_set_id, set_revision_number),
  CONSTRAINT aido_requirement_confirmations_set_project_fkey
    FOREIGN KEY (requirement_set_id, project_id)
    REFERENCES public.aido_requirement_sets(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirement_confirmations_policy_project_fkey
    FOREIGN KEY (project_policy_id, project_id)
    REFERENCES public.aido_project_policies(id, project_id) ON DELETE CASCADE,
  CONSTRAINT aido_requirement_confirmations_revision CHECK (set_revision_number > 0),
  CONSTRAINT aido_requirement_confirmations_integrity
    CHECK (integrity_mode <> 'unknown')
);

CREATE INDEX idx_aido_requirement_confirmations_project_created
  ON public.aido_requirement_confirmations (project_id, confirmed_at DESC);
CREATE INDEX idx_aido_requirement_confirmations_confirmed_by
  ON public.aido_requirement_confirmations (confirmed_by, confirmed_at DESC);
CREATE INDEX idx_aido_requirement_confirmations_policy
  ON public.aido_requirement_confirmations (project_policy_id);

-- ----------------------------------------------------------------------------
-- RLS: owners may read their project data. Worker mutation is service-only;
-- student writes will be exposed later only through narrow security-definer RPCs.
-- ----------------------------------------------------------------------------
ALTER TABLE public.aido_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_ingestion_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_ingestion_service_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_ingestion_job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_parser_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_document_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_document_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_requirement_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_requirement_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_requirement_confirmations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Aido owners read documents v3"
  ON public.aido_documents FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read document versions"
  ON public.aido_document_versions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read ingestion jobs"
  ON public.aido_ingestion_jobs FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read ingestion attempts"
  ON public.aido_ingestion_attempts FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.aido_ingestion_jobs job
      JOIN public.aido_writing_projects project ON project.id = job.project_id
      WHERE job.id = job_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read ingestion service events"
  ON public.aido_ingestion_service_events FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read ingestion job events"
  ON public.aido_ingestion_job_events FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read parser runs"
  ON public.aido_parser_runs FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read document pages"
  ON public.aido_document_pages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read document sections"
  ON public.aido_document_sections FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read document chunks"
  ON public.aido_document_chunks FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read extraction runs"
  ON public.aido_extraction_runs FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read requirement sets"
  ON public.aido_requirement_sets FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read requirements"
  ON public.aido_requirements FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read requirement revisions"
  ON public.aido_requirement_revisions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

CREATE POLICY "Aido owners read requirement confirmations"
  ON public.aido_requirement_confirmations FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.aido_writing_projects project
      WHERE project.id = project_id AND project.owner_id = (select auth.uid())
    )
  );

-- ----------------------------------------------------------------------------
-- Explicit least-privilege Data API grants
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE
  public.aido_documents,
  public.aido_document_versions,
  public.aido_ingestion_jobs,
  public.aido_ingestion_attempts,
  public.aido_ingestion_service_events,
  public.aido_ingestion_job_events,
  public.aido_parser_runs,
  public.aido_document_pages,
  public.aido_document_sections,
  public.aido_document_chunks,
  public.aido_extraction_runs,
  public.aido_requirement_sets,
  public.aido_requirements,
  public.aido_requirement_revisions,
  public.aido_requirement_confirmations
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
  public.aido_documents,
  public.aido_document_versions,
  public.aido_ingestion_jobs,
  public.aido_ingestion_attempts,
  public.aido_ingestion_service_events,
  public.aido_ingestion_job_events,
  public.aido_parser_runs,
  public.aido_document_pages,
  public.aido_document_sections,
  public.aido_document_chunks,
  public.aido_extraction_runs,
  public.aido_requirement_sets,
  public.aido_requirements,
  public.aido_requirement_revisions,
  public.aido_requirement_confirmations
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.aido_documents,
  public.aido_document_versions,
  public.aido_ingestion_jobs,
  public.aido_ingestion_attempts,
  public.aido_parser_runs,
  public.aido_document_pages,
  public.aido_document_sections,
  public.aido_document_chunks,
  public.aido_extraction_runs,
  public.aido_requirement_sets,
  public.aido_requirements
TO service_role;

GRANT SELECT, INSERT ON TABLE
  public.aido_ingestion_service_events,
  public.aido_ingestion_job_events,
  public.aido_requirement_revisions,
  public.aido_requirement_confirmations
TO service_role;

GRANT USAGE, SELECT ON SEQUENCE
  public.aido_ingestion_service_events_id_seq,
  public.aido_ingestion_job_events_id_seq,
  public.aido_requirement_revisions_id_seq
TO service_role;

-- Legacy binary .doc is not supported by the Phase 3 parser pipeline.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'text/plain'
]::text[]
WHERE id = 'aido-assignment-files';
