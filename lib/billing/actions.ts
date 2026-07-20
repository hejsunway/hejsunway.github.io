"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { requireAuthOrRedirect } from "@/lib/auth/actions";
import { createBillingAdminClient } from "@/lib/billing/admin";
import { createStripeClient } from "@/lib/billing/stripe";

export async function startCreditCheckout(formData: FormData) {
  const user = await requireAuthOrRedirect("/app/billing");
  const productKey = String(formData.get("productKey") ?? "");
  if (!/^[a-z][a-z0-9_.-]{2,79}$/.test(productKey)) throw new Error("Invalid credit product.");

  const admin = createBillingAdminClient();
  const now = new Date().toISOString();
  const { data: product, error: productError } = await admin
    .from("aido_credit_products")
    .select("*")
    .eq("product_key", productKey)
    .lte("effective_from", now)
    .or(`effective_to.is.null,effective_to.gt.${now}`)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (productError || !product) throw productError ?? new Error("Credit product is unavailable.");
  if (!["topup", "subscription"].includes(product.kind)) throw new Error("Credit product is not checkout-enabled.");

  const stripe = createStripeClient();
  const customerResult = await admin
    .from("aido_payment_customers")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (customerResult.error) throw customerResult.error;
  let customerMapping = customerResult.data;
  if (!customerMapping) {
    const customer = await stripe.customers.create(
      { email: user.email, metadata: { aido_user_id: user.id } },
      { idempotencyKey: `aido-customer-${user.id}` },
    );
    const inserted = await admin.from("aido_payment_customers").insert({
      user_id: user.id,
      stripe_customer_id: customer.id,
    }).select("stripe_customer_id").single();
    if (inserted.error) {
      const existing = await admin.from("aido_payment_customers")
        .select("stripe_customer_id").eq("user_id", user.id).single();
      if (existing.error) throw inserted.error;
      customerMapping = existing.data;
    } else {
      customerMapping = inserted.data;
    }
  }

  if (product.kind === "subscription") {
    const existingSubscription = await admin
      .from("aido_subscriptions")
      .select("stripe_subscription_id")
      .eq("user_id", user.id)
      .in("status", ["incomplete", "trialing", "active", "past_due", "unpaid", "paused"])
      .limit(1)
      .maybeSingle();
    if (existingSubscription.error) throw existingSubscription.error;
    if (existingSubscription.data) {
      throw new Error("You already have a subscription. Manage it from the billing portal.");
    }
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) throw new Error("NEXT_PUBLIC_SITE_URL is not configured.");
  const session = await stripe.checkout.sessions.create({
    mode: product.kind === "subscription" ? "subscription" : "payment",
    customer: customerMapping.stripe_customer_id,
    client_reference_id: user.id,
    line_items: [{ price: product.stripe_price_id, quantity: 1 }],
    success_url: `${siteUrl}/app/billing?checkout=success`,
    cancel_url: `${siteUrl}/app/billing?checkout=cancelled`,
    metadata: { aido_product_key: product.product_key },
    subscription_data: product.kind === "subscription"
      ? { metadata: { aido_user_id: user.id, aido_product_key: product.product_key } }
      : undefined,
  }, { idempotencyKey: `aido-checkout-${user.id}-${product.id}-${randomUUID()}` });
  if (!session.url) throw new Error("Stripe Checkout returned no URL.");
  redirect(session.url);
}

export async function openBillingPortal() {
  const user = await requireAuthOrRedirect("/app/billing");
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;
  if (!siteUrl || !configuration) {
    throw new Error("The Stripe billing portal is not configured.");
  }

  const admin = createBillingAdminClient();
  const { data: customer, error } = await admin
    .from("aido_payment_customers")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (!customer) throw new Error("No Stripe billing profile exists for this account.");

  const session = await createStripeClient().billingPortal.sessions.create({
    customer: customer.stripe_customer_id,
    configuration,
    return_url: `${siteUrl}/app/billing`,
  });
  redirect(session.url);
}
