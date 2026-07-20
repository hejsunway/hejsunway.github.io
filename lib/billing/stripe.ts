import "server-only";

import Stripe from "stripe";

export function createStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured on the server.");
  return new Stripe(key);
}

export function assertStripeLivemode(livemode: boolean) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured on the server.");
  const configuredLivemode = key.startsWith("sk_live_") || key.startsWith("rk_live_")
    ? true
    : key.startsWith("sk_test_") || key.startsWith("rk_test_")
      ? false
      : null;
  if (configuredLivemode === null) {
    throw new Error("STRIPE_SECRET_KEY has an unsupported mode prefix.");
  }
  if (configuredLivemode !== livemode) {
    throw new Error("Stripe event mode does not match this deployment's configured key.");
  }
}
