-- =============================================================================
-- Migration: AidoForMe Phase 2 durable reconciliation
--
-- Reconciliation never grants, captures, releases, or reverses credits. It
-- records discrepancies for operator review. Provider invoices are immutable
-- imports identified by a SHA-256 digest; corrections supersede an older row.
-- =============================================================================

CREATE TYPE public.aido_reconciliation_run_status AS ENUM (
  'running',
  'completed',
  'failed'
);

CREATE TYPE public.aido_reconciliation_issue_severity AS ENUM (
  'warning',
  'critical'
);

CREATE TABLE public.aido_provider_invoice_imports (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 text NOT NULL,
  invoice_reference        text NOT NULL,
  period_start             timestamptz NOT NULL,
  period_end               timestamptz NOT NULL,
  billed_microusd          bigint NOT NULL,
  currency                 text NOT NULL DEFAULT 'USD',
  source_sha256            text NOT NULL,
  supersedes_invoice_id    uuid REFERENCES public.aido_provider_invoice_imports(id) ON DELETE RESTRICT,
  imported_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  imported_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_provider_invoice_reference_unique UNIQUE (provider, invoice_reference),
  CONSTRAINT aido_provider_invoice_supersedes_unique UNIQUE (supersedes_invoice_id),
  CONSTRAINT aido_provider_invoice_provider CHECK (
    char_length(btrim(provider)) BETWEEN 1 AND 80
  ),
  CONSTRAINT aido_provider_invoice_period CHECK (period_end > period_start),
  CONSTRAINT aido_provider_invoice_amount CHECK (billed_microusd >= 0),
  CONSTRAINT aido_provider_invoice_currency CHECK (currency = 'USD'),
  CONSTRAINT aido_provider_invoice_source_hash CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT aido_provider_invoice_no_self_supersede CHECK (supersedes_invoice_id IS DISTINCT FROM id)
);

CREATE INDEX idx_aido_provider_invoice_period
  ON public.aido_provider_invoice_imports (provider, period_start, period_end);

CREATE OR REPLACE FUNCTION public.aido_validate_provider_invoice_supersession()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_prior public.aido_provider_invoice_imports%ROWTYPE;
BEGIN
  IF NEW.supersedes_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT invoice.* INTO v_prior
  FROM public.aido_provider_invoice_imports invoice
  WHERE invoice.id = NEW.supersedes_invoice_id
  FOR SHARE;
  IF NOT FOUND
     OR v_prior.provider <> NEW.provider
     OR v_prior.period_start <> NEW.period_start
     OR v_prior.period_end <> NEW.period_end THEN
    RAISE EXCEPTION 'invalid_provider_invoice_supersession' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER aido_validate_provider_invoice_supersession
  BEFORE INSERT ON public.aido_provider_invoice_imports
  FOR EACH ROW EXECUTE FUNCTION public.aido_validate_provider_invoice_supersession();
CREATE TRIGGER aido_immutable_provider_invoice_imports
  BEFORE UPDATE OR DELETE ON public.aido_provider_invoice_imports
  FOR EACH ROW EXECUTE FUNCTION public.aido_reject_historical_mutation();

CREATE TABLE public.aido_reconciliation_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                    text NOT NULL,
  status                   public.aido_reconciliation_run_status NOT NULL DEFAULT 'running',
  internal_checked_count   integer NOT NULL DEFAULT 0,
  stripe_checked_count     integer NOT NULL DEFAULT 0,
  invoice_checked_count    integer NOT NULL DEFAULT 0,
  issue_count              integer NOT NULL DEFAULT 0,
  failure_code             text,
  failure_message          text,
  started_at               timestamptz NOT NULL DEFAULT now(),
  completed_at             timestamptz,
  CONSTRAINT aido_reconciliation_runs_scope CHECK (
    char_length(btrim(scope)) BETWEEN 1 AND 80
  ),
  CONSTRAINT aido_reconciliation_runs_counts CHECK (
    internal_checked_count >= 0
    AND stripe_checked_count >= 0
    AND invoice_checked_count >= 0
    AND issue_count >= 0
  ),
  CONSTRAINT aido_reconciliation_runs_status CHECK (
    (status = 'running' AND completed_at IS NULL AND failure_code IS NULL AND failure_message IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND failure_code IS NULL AND failure_message IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND failure_code IS NOT NULL)
  )
);

CREATE INDEX idx_aido_reconciliation_runs_started
  ON public.aido_reconciliation_runs (started_at DESC);

CREATE TABLE public.aido_reconciliation_run_issues (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                   uuid NOT NULL REFERENCES public.aido_reconciliation_runs(id) ON DELETE CASCADE,
  severity                 public.aido_reconciliation_issue_severity NOT NULL,
  category                 text NOT NULL,
  entity_id                text NOT NULL,
  details                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_reconciliation_issue_unique UNIQUE (run_id, category, entity_id),
  CONSTRAINT aido_reconciliation_issue_names CHECK (
    char_length(btrim(category)) BETWEEN 1 AND 120
    AND char_length(btrim(entity_id)) BETWEEN 1 AND 255
  ),
  CONSTRAINT aido_reconciliation_issue_details CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX idx_aido_reconciliation_issues_run
  ON public.aido_reconciliation_run_issues (run_id, severity, category);

CREATE TRIGGER aido_immutable_reconciliation_run_issues
  BEFORE UPDATE OR DELETE ON public.aido_reconciliation_run_issues
  FOR EACH ROW EXECUTE FUNCTION public.aido_reject_historical_mutation();

ALTER TABLE public.aido_provider_invoice_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_reconciliation_run_issues ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.aido_provider_invoice_imports,
  public.aido_reconciliation_runs,
  public.aido_reconciliation_run_issues
FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE
  public.aido_provider_invoice_imports,
  public.aido_reconciliation_runs,
  public.aido_reconciliation_run_issues
TO service_role;

CREATE OR REPLACE FUNCTION public.aido_provider_invoice_reconciliation_issues()
RETURNS TABLE (category text, entity_id text, details jsonb)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    'provider_invoice_cost_mismatch'::text,
    invoice.id::text,
    jsonb_build_object(
      'provider', invoice.provider,
      'invoice_reference', invoice.invoice_reference,
      'period_start', invoice.period_start,
      'period_end', invoice.period_end,
      'billed_microusd', invoice.billed_microusd,
      'recorded_usage_microusd', COALESCE(sum(event.provider_cost_microusd), 0)::bigint,
      'difference_microusd', invoice.billed_microusd - COALESCE(sum(event.provider_cost_microusd), 0)::bigint
    )
  FROM public.aido_provider_invoice_imports invoice
  LEFT JOIN public.aido_usage_events event
    ON event.provider = invoice.provider
   AND event.created_at >= invoice.period_start
   AND event.created_at < invoice.period_end
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.aido_provider_invoice_imports correction
    WHERE correction.supersedes_invoice_id = invoice.id
  )
  GROUP BY invoice.id
  HAVING invoice.billed_microusd <> COALESCE(sum(event.provider_cost_microusd), 0)::bigint;
$$;

REVOKE ALL ON FUNCTION public.aido_validate_provider_invoice_supersession()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.aido_provider_invoice_reconciliation_issues()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aido_provider_invoice_reconciliation_issues()
  TO service_role;

NOTIFY pgrst, 'reload schema';
