import type Stripe from "stripe";
import { createBillingAdminClient } from "@/lib/billing/admin";
import { createStripeClient } from "@/lib/billing/stripe";
import { isAuthorizedCronRequest } from "@/lib/internal/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

type ReconciliationIssue = {
  severity: "warning" | "critical";
  category: string;
  entity_id: string;
  details: Record<string, unknown>;
};

function objectId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function stripeTime(value: number): string {
  return new Date(value * 1000).toISOString();
}

function stripeFailureDetails(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return { code: "stripe_lookup_failed" };
  const candidate = error as { code?: unknown; type?: unknown; statusCode?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : "stripe_lookup_failed",
    type: typeof candidate.type === "string" ? candidate.type : null,
    status_code: typeof candidate.statusCode === "number" ? candidate.statusCode : null,
  };
}

async function reconcileSubscriptions(stripe: Stripe): Promise<{ checked: number; issues: ReconciliationIssue[] }> {
  const admin = createBillingAdminClient();
  const { data, error } = await admin
    .from("aido_subscriptions")
    .select("stripe_subscription_id,stripe_customer_id,stripe_price_id,status,cancel_at_period_end,current_period_start,current_period_end,livemode")
    .order("last_synced_at", { ascending: false })
    .limit(101);
  if (error) throw error;
  const subscriptions = data ?? [];
  const issues: ReconciliationIssue[] = [];
  if (subscriptions.length > 100) {
    issues.push({
      severity: "critical",
      category: "stripe_subscription_scan_truncated",
      entity_id: "subscriptions",
      details: { maximum_checked: 100 },
    });
  }

  const selected = subscriptions.slice(0, 100);
  for (let offset = 0; offset < selected.length; offset += 5) {
    const batch = selected.slice(offset, offset + 5);
    const results = await Promise.allSettled(batch.map(async (local) => {
      const remote = await stripe.subscriptions.retrieve(local.stripe_subscription_id, {
        expand: ["items.data.price"],
      });
      const item = remote.items.data.length === 1 ? remote.items.data[0] : null;
      const facts = item ? {
        stripe_customer_id: objectId(remote.customer),
        stripe_price_id: objectId(item.price),
        status: remote.status,
        cancel_at_period_end: remote.cancel_at_period_end,
        current_period_start: stripeTime(item.current_period_start),
        current_period_end: stripeTime(item.current_period_end),
        livemode: remote.livemode,
      } : null;
      const localFacts = {
        stripe_customer_id: local.stripe_customer_id,
        stripe_price_id: local.stripe_price_id,
        status: local.status,
        cancel_at_period_end: local.cancel_at_period_end,
        current_period_start: new Date(local.current_period_start).toISOString(),
        current_period_end: new Date(local.current_period_end).toISOString(),
        livemode: local.livemode,
      };
      if (!facts || JSON.stringify(facts) !== JSON.stringify(localFacts)) {
        issues.push({
          severity: "critical",
          category: "stripe_subscription_mismatch",
          entity_id: local.stripe_subscription_id,
          details: { local: localFacts, stripe: facts },
        });
      }
    }));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        issues.push({
          severity: "critical",
          category: "stripe_subscription_lookup_failed",
          entity_id: batch[index].stripe_subscription_id,
          details: stripeFailureDetails(result.reason),
        });
      }
    });
  }
  return { checked: selected.length, issues };
}

async function reconcilePaymentEvents(stripe: Stripe): Promise<{ checked: number; issues: ReconciliationIssue[] }> {
  const admin = createBillingAdminClient();
  const since = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("aido_payment_events")
    .select("stripe_event_id,event_kind,stripe_object_id,livemode,currency,amount_gross_sen")
    .eq("status", "processed")
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(101);
  if (error) throw error;
  const events = data ?? [];
  const issues: ReconciliationIssue[] = [];
  if (events.length > 100) {
    issues.push({
      severity: "critical",
      category: "stripe_payment_scan_truncated",
      entity_id: "payment_events",
      details: { lookback_days: 35, maximum_checked: 100 },
    });
  }

  const selected = events.slice(0, 100);
  for (let offset = 0; offset < selected.length; offset += 5) {
    const batch = selected.slice(offset, offset + 5);
    const results = await Promise.allSettled(batch.map(async (event) => {
      let amount: number;
      let currency: string;
      let livemode: boolean;
      if (event.event_kind === "purchase" || event.event_kind === "renewal") {
        const charge = await stripe.charges.retrieve(event.stripe_object_id);
        amount = charge.amount;
        currency = charge.currency;
        livemode = charge.livemode;
      } else if (event.event_kind === "refund") {
        const refund = await stripe.refunds.retrieve(event.stripe_object_id);
        const chargeId = objectId(refund.charge);
        if (!chargeId) throw new Error("Refund is missing its charge.");
        const charge = await stripe.charges.retrieve(chargeId);
        amount = refund.amount;
        currency = refund.currency;
        livemode = charge.livemode;
      } else if (event.event_kind === "dispute") {
        const dispute = await stripe.disputes.retrieve(event.stripe_object_id);
        amount = dispute.amount;
        currency = dispute.currency;
        livemode = dispute.livemode;
      } else {
        return;
      }
      if (
        amount !== event.amount_gross_sen
        || currency.toUpperCase() !== event.currency
        || livemode !== event.livemode
      ) {
        issues.push({
          severity: "critical",
          category: "stripe_payment_mismatch",
          entity_id: event.stripe_event_id,
          details: {
            local: { amount: event.amount_gross_sen, currency: event.currency, livemode: event.livemode },
            stripe: { amount, currency: currency.toUpperCase(), livemode },
          },
        });
      }
    }));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        issues.push({
          severity: "critical",
          category: "stripe_payment_lookup_failed",
          entity_id: batch[index].stripe_event_id,
          details: stripeFailureDetails(result.reason),
        });
      }
    });
  }
  return { checked: selected.length, issues };
}

async function runReconciliation(request: Request) {
  if (!process.env.CRON_SECRET) return new Response("Reconciliation is not configured.", { status: 503 });
  if (!isAuthorizedCronRequest(request)) return new Response("Unauthorized.", { status: 401 });

  const admin = createBillingAdminClient();
  const { data: run, error: runError } = await admin
    .from("aido_reconciliation_runs")
    .insert({ scope: "scheduled" })
    .select("id")
    .single();
  if (runError) throw runError;

  try {
    const [internalResult, providerInvoiceResult, providerDispatchResult, expiryResult] = await Promise.all([
      admin.rpc("aido_reconciliation_issues"),
      admin.rpc("aido_provider_invoice_reconciliation_issues"),
      admin.rpc("aido_provider_dispatch_reconciliation_issues"),
      admin.rpc("aido_expiry_reconciliation_issues"),
    ]);
    if (internalResult.error) throw internalResult.error;
    if (providerInvoiceResult.error) throw providerInvoiceResult.error;
    if (providerDispatchResult.error) throw providerDispatchResult.error;
    if (expiryResult.error) throw expiryResult.error;

    const internal = (internalResult.data ?? []) as Array<{ category: string; entity_id: string; details: Record<string, unknown> }>;
    const providerInvoices = (providerInvoiceResult.data ?? []) as Array<{ category: string; entity_id: string; details: Record<string, unknown> }>;
    const providerDispatches = (providerDispatchResult.data ?? []) as Array<{ category: string; entity_id: string; details: Record<string, unknown> }>;
    const expiryIssues = (expiryResult.data ?? []) as Array<{ category: string; entity_id: string; details: Record<string, unknown> }>;
    const { data: invoiceRows, error: invoiceCountError } = await admin
      .from("aido_provider_invoice_imports")
      .select("id,supersedes_invoice_id");
    if (invoiceCountError) throw invoiceCountError;
    const supersededIds = new Set((invoiceRows ?? []).map((row) => row.supersedes_invoice_id).filter(Boolean));
    const activeInvoiceCount = (invoiceRows ?? []).filter((row) => !supersededIds.has(row.id)).length;
    const issues: ReconciliationIssue[] = [
      ...internal.map((issue) => ({ ...issue, severity: "critical" as const })),
      ...providerInvoices.map((issue) => ({ ...issue, severity: "critical" as const })),
      ...providerDispatches.map((issue) => ({ ...issue, severity: "critical" as const })),
      ...expiryIssues.map((issue) => ({ ...issue, severity: "critical" as const })),
    ];

    let stripeChecked = 0;
    if (process.env.STRIPE_SECRET_KEY) {
      const stripe = createStripeClient();
      const [subscriptions, payments] = await Promise.all([
        reconcileSubscriptions(stripe),
        reconcilePaymentEvents(stripe),
      ]);
      stripeChecked = subscriptions.checked + payments.checked;
      issues.push(...subscriptions.issues, ...payments.issues);
    } else {
      issues.push({
        severity: "critical",
        category: "stripe_reconciliation_not_configured",
        entity_id: "STRIPE_SECRET_KEY",
        details: {},
      });
    }

    if (issues.length) {
      const { error: issueError } = await admin.from("aido_reconciliation_run_issues").insert(
        issues.map((issue) => ({ run_id: run.id, ...issue })),
      );
      if (issueError) throw issueError;
    }
    const { error: completeError } = await admin.from("aido_reconciliation_runs").update({
      status: "completed",
      internal_checked_count: 6,
      stripe_checked_count: stripeChecked,
      invoice_checked_count: activeInvoiceCount,
      issue_count: issues.length,
      completed_at: new Date().toISOString(),
    }).eq("id", run.id);
    if (completeError) throw completeError;
    return Response.json({ run_id: run.id, status: "completed", issue_count: issues.length });
  } catch (error) {
    const failureCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "reconciliation_failed";
    console.error("Aido reconciliation failed", { runId: run.id, code: failureCode });
    await admin.from("aido_reconciliation_runs").update({
      status: "failed",
      failure_code: failureCode.slice(0, 120),
      failure_message: "Reconciliation did not complete. Review server logs using the run ID.",
      completed_at: new Date().toISOString(),
    }).eq("id", run.id);
    return Response.json({ run_id: run.id, status: "failed" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return runReconciliation(request);
}

export async function POST(request: Request) {
  return runReconciliation(request);
}
