-- Cover the two additive Phase 2 foreign keys reported by the staging
-- performance advisor. Both indexes are intentionally narrow and partial
-- where NULL values do not participate in the relationship.

CREATE INDEX idx_aido_subscription_events_credit_product
  ON public.aido_subscription_events (credit_product_id);

CREATE INDEX idx_aido_provider_invoice_imports_imported_by
  ON public.aido_provider_invoice_imports (imported_by)
  WHERE imported_by IS NOT NULL;
