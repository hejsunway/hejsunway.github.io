-- =============================================================================
-- Migration: AidoForMe Phase 2 subscription lifecycle
--
-- Stripe remains the billing system of record. These tables keep a minimal,
-- server-written projection for the product UI and an append-only journal of
-- signature-verified lifecycle events. Credit grants continue to be handled
-- only by aido_process_verified_purchase_event after a settled invoice.
-- =============================================================================

CREATE TYPE public.aido_subscription_status AS ENUM (
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused'
);

CREATE TABLE public.aido_subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credit_product_id        uuid NOT NULL REFERENCES public.aido_credit_products(id) ON DELETE RESTRICT,
  stripe_customer_id       text NOT NULL,
  stripe_subscription_id   text NOT NULL,
  stripe_price_id          text NOT NULL,
  status                   public.aido_subscription_status NOT NULL,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  current_period_start     timestamptz NOT NULL,
  current_period_end       timestamptz NOT NULL,
  cancel_at                timestamptz,
  canceled_at              timestamptz,
  ended_at                 timestamptz,
  trial_start              timestamptz,
  trial_end                timestamptz,
  latest_invoice_id        text,
  last_payment_failed_at   timestamptz,
  livemode                 boolean NOT NULL,
  last_stripe_event_id     text NOT NULL,
  last_stripe_event_type   text NOT NULL,
  last_event_created_at    timestamptz NOT NULL,
  last_synced_at           timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_subscriptions_stripe_unique UNIQUE (stripe_subscription_id),
  CONSTRAINT aido_subscriptions_identifiers CHECK (
    stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'
    AND stripe_price_id ~ '^price_[A-Za-z0-9]+$'
    AND last_stripe_event_id ~ '^evt_[A-Za-z0-9]+$'
  ),
  CONSTRAINT aido_subscriptions_event_type_length CHECK (
    char_length(btrim(last_stripe_event_type)) BETWEEN 1 AND 160
  ),
  CONSTRAINT aido_subscriptions_period CHECK (current_period_end > current_period_start),
  CONSTRAINT aido_subscriptions_trial_period CHECK (
    trial_start IS NULL OR trial_end IS NULL OR trial_end > trial_start
  )
);

CREATE INDEX idx_aido_subscriptions_user_status
  ON public.aido_subscriptions (user_id, status, current_period_end DESC);
CREATE INDEX idx_aido_subscriptions_customer
  ON public.aido_subscriptions (stripe_customer_id);
CREATE INDEX idx_aido_subscriptions_product
  ON public.aido_subscriptions (credit_product_id);

CREATE TRIGGER aido_set_subscriptions_updated_at
  BEFORE UPDATE ON public.aido_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.aido_set_updated_at();

CREATE TABLE public.aido_subscription_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id          text NOT NULL,
  stripe_event_type        text NOT NULL,
  stripe_subscription_id   text NOT NULL,
  stripe_customer_id       text NOT NULL,
  stripe_price_id          text NOT NULL,
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credit_product_id        uuid NOT NULL REFERENCES public.aido_credit_products(id) ON DELETE RESTRICT,
  subscription_status      public.aido_subscription_status NOT NULL,
  event_created_at         timestamptz NOT NULL,
  payload_sha256           text NOT NULL,
  projection_applied       boolean NOT NULL,
  received_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aido_subscription_events_stripe_unique UNIQUE (stripe_event_id),
  CONSTRAINT aido_subscription_events_identifiers CHECK (
    stripe_event_id ~ '^evt_[A-Za-z0-9]+$'
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'
    AND stripe_price_id ~ '^price_[A-Za-z0-9]+$'
  ),
  CONSTRAINT aido_subscription_events_type_length CHECK (
    char_length(btrim(stripe_event_type)) BETWEEN 1 AND 160
  ),
  CONSTRAINT aido_subscription_events_payload_hash CHECK (
    payload_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX idx_aido_subscription_events_subscription_created
  ON public.aido_subscription_events (stripe_subscription_id, event_created_at DESC);
CREATE INDEX idx_aido_subscription_events_user_created
  ON public.aido_subscription_events (user_id, event_created_at DESC);

ALTER TABLE public.aido_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aido_subscription_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Aido users read own subscriptions"
  ON public.aido_subscriptions FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

REVOKE ALL ON TABLE
  public.aido_subscriptions,
  public.aido_subscription_events
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.aido_subscriptions TO authenticated;
GRANT ALL ON TABLE
  public.aido_subscriptions,
  public.aido_subscription_events
TO service_role;

-- The caller supplies facts only after Stripe signature verification and an
-- authoritative subscription retrieve. The function independently binds the
-- Stripe customer and price to Aido-owned rows, journals the event exactly
-- once, and applies only non-stale projections.
CREATE OR REPLACE FUNCTION public.aido_process_verified_subscription_event(
  p_stripe_event_id text,
  p_stripe_event_type text,
  p_event_created_at timestamptz,
  p_payload_sha256 text,
  p_livemode boolean,
  p_stripe_subscription_id text,
  p_stripe_customer_id text,
  p_stripe_price_id text,
  p_status public.aido_subscription_status,
  p_cancel_at_period_end boolean,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_cancel_at timestamptz DEFAULT NULL,
  p_canceled_at timestamptz DEFAULT NULL,
  p_ended_at timestamptz DEFAULT NULL,
  p_trial_start timestamptz DEFAULT NULL,
  p_trial_end timestamptz DEFAULT NULL,
  p_latest_invoice_id text DEFAULT NULL,
  p_payment_state text DEFAULT 'unchanged'
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_customer public.aido_payment_customers%ROWTYPE;
  v_product public.aido_credit_products%ROWTYPE;
  v_existing_event public.aido_subscription_events%ROWTYPE;
  v_existing_subscription public.aido_subscriptions%ROWTYPE;
  v_projection_applied boolean;
BEGIN
  IF p_stripe_event_id !~ '^evt_[A-Za-z0-9]+$'
     OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9]+$'
     OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9]+$'
     OR p_stripe_price_id !~ '^price_[A-Za-z0-9]+$'
     OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
     OR char_length(btrim(p_stripe_event_type)) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'invalid_subscription_event_facts' USING ERRCODE = '22023';
  END IF;
  IF p_current_period_end <= p_current_period_start THEN
    RAISE EXCEPTION 'invalid_subscription_period' USING ERRCODE = '22023';
  END IF;
  IF p_payment_state NOT IN ('unchanged', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid_subscription_payment_state' USING ERRCODE = '22023';
  END IF;

  SELECT customer.* INTO v_customer
  FROM public.aido_payment_customers customer
  WHERE customer.stripe_customer_id = p_stripe_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_stripe_customer' USING ERRCODE = 'P0001';
  END IF;

  SELECT product.* INTO v_product
  FROM public.aido_credit_products product
  WHERE product.stripe_price_id = p_stripe_price_id
    AND product.kind = 'subscription';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_subscription_price' USING ERRCODE = 'P0001';
  END IF;

  SELECT event_row.* INTO v_existing_event
  FROM public.aido_subscription_events event_row
  WHERE event_row.stripe_event_id = p_stripe_event_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing_event.stripe_event_type <> p_stripe_event_type
       OR v_existing_event.stripe_subscription_id <> p_stripe_subscription_id
       OR v_existing_event.stripe_customer_id <> p_stripe_customer_id
       OR v_existing_event.stripe_price_id <> p_stripe_price_id
       OR v_existing_event.payload_sha256 <> p_payload_sha256 THEN
      RAISE EXCEPTION 'stripe_event_fact_mismatch' USING ERRCODE = 'P0001';
    END IF;
    RETURN 'duplicate';
  END IF;

  SELECT subscription.* INTO v_existing_subscription
  FROM public.aido_subscriptions subscription
  WHERE subscription.stripe_subscription_id = p_stripe_subscription_id
  FOR UPDATE;

  IF FOUND AND (
    v_existing_subscription.user_id <> v_customer.user_id
    OR v_existing_subscription.stripe_customer_id <> p_stripe_customer_id
    OR v_existing_subscription.livemode <> p_livemode
  ) THEN
    RAISE EXCEPTION 'subscription_identity_mismatch' USING ERRCODE = 'P0001';
  END IF;

  v_projection_applied := NOT FOUND
    OR v_existing_subscription.last_event_created_at <= p_event_created_at;

  INSERT INTO public.aido_subscription_events (
    stripe_event_id, stripe_event_type, stripe_subscription_id,
    stripe_customer_id, stripe_price_id, user_id, credit_product_id,
    subscription_status, event_created_at, payload_sha256, projection_applied
  ) VALUES (
    p_stripe_event_id, p_stripe_event_type, p_stripe_subscription_id,
    p_stripe_customer_id, p_stripe_price_id, v_customer.user_id, v_product.id,
    p_status, p_event_created_at, p_payload_sha256, v_projection_applied
  );

  IF NOT v_projection_applied THEN
    RETURN 'stale';
  END IF;

  INSERT INTO public.aido_subscriptions (
    user_id, credit_product_id, stripe_customer_id, stripe_subscription_id,
    stripe_price_id, status, cancel_at_period_end, current_period_start,
    current_period_end, cancel_at, canceled_at, ended_at, trial_start,
    trial_end, latest_invoice_id, last_payment_failed_at, livemode,
    last_stripe_event_id, last_stripe_event_type, last_event_created_at,
    last_synced_at
  ) VALUES (
    v_customer.user_id, v_product.id, p_stripe_customer_id,
    p_stripe_subscription_id, p_stripe_price_id, p_status,
    p_cancel_at_period_end, p_current_period_start, p_current_period_end,
    p_cancel_at, p_canceled_at, p_ended_at, p_trial_start, p_trial_end,
    p_latest_invoice_id,
    CASE WHEN p_payment_state = 'failed' THEN p_event_created_at ELSE NULL END,
    p_livemode, p_stripe_event_id, p_stripe_event_type, p_event_created_at, now()
  )
  ON CONFLICT (stripe_subscription_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    credit_product_id = EXCLUDED.credit_product_id,
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_price_id = EXCLUDED.stripe_price_id,
    status = EXCLUDED.status,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    cancel_at = EXCLUDED.cancel_at,
    canceled_at = EXCLUDED.canceled_at,
    ended_at = EXCLUDED.ended_at,
    trial_start = EXCLUDED.trial_start,
    trial_end = EXCLUDED.trial_end,
    latest_invoice_id = EXCLUDED.latest_invoice_id,
    last_payment_failed_at = CASE
      WHEN p_payment_state = 'failed' THEN p_event_created_at
      WHEN p_payment_state = 'succeeded' THEN NULL
      ELSE public.aido_subscriptions.last_payment_failed_at
    END,
    livemode = EXCLUDED.livemode,
    last_stripe_event_id = EXCLUDED.last_stripe_event_id,
    last_stripe_event_type = EXCLUDED.last_stripe_event_type,
    last_event_created_at = EXCLUDED.last_event_created_at,
    last_synced_at = now();

  RETURN 'applied';
END;
$$;

REVOKE ALL ON FUNCTION public.aido_process_verified_subscription_event(
  text, text, timestamptz, text, boolean, text, text, text,
  public.aido_subscription_status, boolean, timestamptz, timestamptz,
  timestamptz, timestamptz, timestamptz, timestamptz, timestamptz,
  text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aido_process_verified_subscription_event(
  text, text, timestamptz, text, boolean, text, text, text,
  public.aido_subscription_status, boolean, timestamptz, timestamptz,
  timestamptz, timestamptz, timestamptz, timestamptz, timestamptz,
  text, text
) TO service_role;

NOTIFY pgrst, 'reload schema';
