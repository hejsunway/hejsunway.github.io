import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { createBillingAdminClient } from "@/lib/billing/admin";
import { assertStripeLivemode, createStripeClient } from "@/lib/billing/stripe";

export const runtime = "nodejs";

function objectId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function stripeTime(value: number | null): string | null {
  return value == null ? null : new Date(value * 1000).toISOString();
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return objectId(invoice.parent?.subscription_details?.subscription ?? null);
}

async function processSubscriptionProjection(
  event: Stripe.Event,
  subscriptionId: string,
  digest: string,
  paymentState: "unchanged" | "succeeded" | "failed" = "unchanged",
) {
  const stripe = createStripeClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price", "latest_invoice"],
  });
  const customerId = objectId(subscription.customer);
  const item = subscription.items.data.length === 1 ? subscription.items.data[0] : null;
  const priceId = item ? objectId(item.price) : null;
  if (!customerId || !item || !priceId || item.quantity !== 1) {
    throw new Error("Subscription must contain exactly one mapped price with quantity one.");
  }

  const { error } = await createBillingAdminClient().rpc("aido_process_verified_subscription_event", {
    p_stripe_event_id: event.id,
    p_stripe_event_type: event.type,
    p_event_created_at: stripeTime(event.created),
    p_payload_sha256: digest,
    p_livemode: event.livemode,
    p_stripe_subscription_id: subscription.id,
    p_stripe_customer_id: customerId,
    p_stripe_price_id: priceId,
    p_status: subscription.status,
    p_cancel_at_period_end: subscription.cancel_at_period_end,
    p_current_period_start: stripeTime(item.current_period_start),
    p_current_period_end: stripeTime(item.current_period_end),
    p_cancel_at: stripeTime(subscription.cancel_at),
    p_canceled_at: stripeTime(subscription.canceled_at),
    p_ended_at: stripeTime(subscription.ended_at),
    p_trial_start: stripeTime(subscription.trial_start),
    p_trial_end: stripeTime(subscription.trial_end),
    p_latest_invoice_id: objectId(subscription.latest_invoice),
    p_payment_state: paymentState,
  });
  if (error) throw error;
}

async function processCheckout(event: Stripe.Event, session: Stripe.Checkout.Session, digest: string) {
  if (session.mode !== "payment" || session.payment_status !== "paid") return;
  const stripe = createStripeClient();
  const customerId = objectId(session.customer);
  const paymentIntentId = objectId(session.payment_intent);
  if (!customerId || !paymentIntentId) throw new Error("Paid Checkout session is missing customer or payment intent.");

  const [expandedSession, paymentIntent] = await Promise.all([
    stripe.checkout.sessions.retrieve(session.id, { expand: ["line_items.data.price"] }),
    stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] }),
  ]);
  const lineItems = expandedSession.line_items?.data ?? [];
  if (lineItems.length !== 1 || lineItems[0].quantity !== 1) throw new Error("Checkout session has an invalid credit-product quantity.");
  const priceId = objectId(lineItems[0].price);
  const charge = paymentIntent.latest_charge;
  if (!priceId || !charge || typeof charge === "string") throw new Error("Checkout payment details are incomplete.");
  const balance = charge.balance_transaction;
  if (!balance || typeof balance === "string") throw new Error("Stripe net settlement is not available yet.");
  if (expandedSession.amount_total == null || expandedSession.currency?.toUpperCase() !== "MYR") {
    throw new Error("Checkout amount or currency is invalid.");
  }

  const { error } = await createBillingAdminClient().rpc("aido_process_verified_purchase_event", {
    p_stripe_event_id: event.id,
    p_stripe_event_type: event.type,
    p_event_kind: event.type === "invoice.paid" ? "renewal" : "purchase",
    p_livemode: event.livemode,
    p_stripe_object_id: charge.id,
    p_stripe_customer_id: customerId,
    p_stripe_price_id: priceId,
    p_currency: "MYR",
    p_amount_gross_sen: expandedSession.amount_total,
    p_amount_net_sen: balance.net,
    p_payload_sha256: digest,
  });
  if (error) throw error;
}

async function processPaidInvoice(event: Stripe.Event, invoice: Stripe.Invoice, digest: string) {
  if (invoice.status !== "paid" || invoice.amount_paid <= 0) return;
  const customerId = objectId(invoice.customer);
  const lines = invoice.lines.data.filter((line) => line.amount > 0);
  const priceId = lines.length === 1
    ? objectId(lines[0].pricing?.price_details?.price ?? null)
    : null;
  if (!customerId || !priceId || invoice.currency.toUpperCase() !== "MYR") {
    throw new Error("Paid subscription invoice has unsupported billing facts.");
  }

  const stripe = createStripeClient();
  const invoicePayments = await stripe.invoicePayments.list({
    invoice: invoice.id,
    status: "paid",
    limit: 10,
    expand: ["data.payment.payment_intent.latest_charge.balance_transaction", "data.payment.charge.balance_transaction"],
  });
  const paid = invoicePayments.data.find((payment) => payment.status === "paid");
  if (!paid) throw new Error("Paid invoice has no settled Stripe payment.");
  let charge: Stripe.Charge | null = null;
  if (paid.payment.payment_intent) {
    const paymentIntent = typeof paid.payment.payment_intent === "string"
      ? await stripe.paymentIntents.retrieve(paid.payment.payment_intent, { expand: ["latest_charge.balance_transaction"] })
      : paid.payment.payment_intent;
    charge = typeof paymentIntent.latest_charge === "string" || !paymentIntent.latest_charge
      ? null
      : paymentIntent.latest_charge;
  } else if (paid.payment.charge) {
    charge = typeof paid.payment.charge === "string"
      ? await stripe.charges.retrieve(paid.payment.charge, { expand: ["balance_transaction"] })
      : paid.payment.charge;
  }
  const balance = charge?.balance_transaction;
  if (!charge || !balance || typeof balance === "string") {
    throw new Error("Subscription settlement net amount is not available yet.");
  }

  const { error } = await createBillingAdminClient().rpc("aido_process_verified_purchase_event", {
    p_stripe_event_id: event.id,
    p_stripe_event_type: event.type,
    p_event_kind: "renewal",
    p_livemode: event.livemode,
    p_stripe_object_id: charge.id,
    p_stripe_customer_id: customerId,
    p_stripe_price_id: priceId,
    p_currency: "MYR",
    p_amount_gross_sen: invoice.amount_paid,
    p_amount_net_sen: balance.net,
    p_payload_sha256: digest,
  });
  if (error) throw error;

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (subscriptionId) await processSubscriptionProjection(event, subscriptionId, digest, "succeeded");
}

async function processReversal(event: Stripe.Event, digest: string) {
  const object = event.data.object;
  let stripeObjectId: string;
  let originalChargeId: string | null;
  let amount: number;
  let reversalType: "refund" | "chargeback";
  if (event.type === "refund.created") {
    const refund = object as Stripe.Refund;
    stripeObjectId = refund.id;
    originalChargeId = objectId(refund.charge);
    amount = refund.amount;
    reversalType = "refund";
  } else if (event.type === "charge.dispute.created") {
    const dispute = object as Stripe.Dispute;
    stripeObjectId = dispute.id;
    originalChargeId = objectId(dispute.charge);
    amount = dispute.amount;
    reversalType = "chargeback";
  } else {
    return;
  }
  if (!originalChargeId) throw new Error("Stripe reversal is missing its original charge.");
  const { error } = await createBillingAdminClient().rpc("aido_process_verified_reversal_event", {
    p_stripe_event_id: event.id,
    p_stripe_event_type: event.type,
    p_livemode: event.livemode,
    p_stripe_object_id: stripeObjectId,
    p_original_stripe_object_id: originalChargeId,
    p_amount_sen: amount,
    p_payload_sha256: digest,
    p_reversal_type: reversalType,
  });
  if (error) throw error;
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) return new Response("Webhook is not configured.", { status: 503 });
  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = createStripeClient().webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    return new Response("Invalid Stripe signature.", { status: 400 });
  }

  try {
    assertStripeLivemode(event.livemode);
    const digest = createHash("sha256").update(body).digest("hex");
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription") {
        const subscriptionId = objectId(session.subscription);
        if (!subscriptionId) throw new Error("Subscription Checkout session is missing its subscription.");
        await processSubscriptionProjection(event, subscriptionId, digest);
      } else {
        await processCheckout(event, session, digest);
      }
    } else if (event.type === "invoice.paid") {
      await processPaidInvoice(event, event.data.object as Stripe.Invoice, digest);
    } else if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = invoiceSubscriptionId(invoice);
      if (!subscriptionId) throw new Error("Failed invoice is not attached to a subscription.");
      await processSubscriptionProjection(event, subscriptionId, digest, "failed");
    } else if (
      event.type === "customer.subscription.created"
      || event.type === "customer.subscription.updated"
      || event.type === "customer.subscription.deleted"
      || event.type === "customer.subscription.paused"
      || event.type === "customer.subscription.resumed"
    ) {
      const subscription = event.data.object as Stripe.Subscription;
      await processSubscriptionProjection(event, subscription.id, digest);
    } else if (event.type === "refund.created" || event.type === "charge.dispute.created") {
      await processReversal(event, digest);
    }
    return Response.json({ received: true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "stripe_event_reconciliation_failed";
    console.error("Stripe webhook reconciliation failed", { eventId: event.id, eventType: event.type, code });
    return new Response("Stripe event could not be reconciled.", { status: 500 });
  }
}
