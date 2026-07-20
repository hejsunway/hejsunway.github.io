import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import Stripe from "stripe";

const STAGING_PROJECT_REF = "vokjkogzvtohdinhxhkk";
const STAGING_SUPABASE_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
const STAGING_APP_URL = "https://aidofor-me-2afl.vercel.app";
const EXPECTED_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "refund.created",
  "charge.dispute.created",
].sort();

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseEnvFile(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) value = value.slice(1, -1);
    values[name] = value;
  }
  return values;
}

function requireValue(values, name) {
  const value = values[name] || process.env[name];
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function expectedMetadata(product) {
  return {
    aido_product_key: product.product_key,
    credit_grant: String(product.credit_grant),
    environment: "staging",
    expires_after_days: String(product.expires_after_days),
  };
}

function metadataMatches(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

function restoreMetadataPatch(previous, expected) {
  return Object.fromEntries(
    Object.keys(expected).map((key) => [key, previous?.[key] ?? ""]),
  );
}

async function updateStripeMetadata(stripe, update, metadata) {
  if (update.object === "product") {
    await stripe.products.update(update.id, { metadata });
  } else {
    await stripe.prices.update(update.id, { metadata });
  }
}

async function retrieveStripeMetadata(stripe, update) {
  const object = update.object === "product"
    ? await stripe.products.retrieve(update.id)
    : await stripe.prices.retrieve(update.id);
  return object.metadata;
}

async function assertCatalogReadback(stripe, creditProducts) {
  for (const product of creditProducts) {
    const [stripeProduct, stripePrice] = await Promise.all([
      stripe.products.retrieve(product.stripe_product_id),
      stripe.prices.retrieve(product.stripe_price_id),
    ]);
    const expected = expectedMetadata(product);
    if (
      structuralProblems(product, stripeProduct, stripePrice).length
      || !metadataMatches(stripeProduct.metadata, expected)
      || !metadataMatches(stripePrice.metadata, expected)
    ) throw new Error(`Stripe catalog read-back failed for ${product.product_key}.`);
  }
}

function structuralProblems(product, stripeProduct, stripePrice) {
  const problems = [];
  const recurringIsCorrect = product.kind === "subscription"
    ? stripePrice.type === "recurring"
      && stripePrice.recurring?.interval === "month"
      && stripePrice.recurring.interval_count === 1
      && stripePrice.recurring.usage_type === "licensed"
    : stripePrice.type === "one_time" && stripePrice.recurring === null;
  if (stripeProduct.deleted) problems.push("product_deleted");
  if (!stripeProduct.active || !stripePrice.active) problems.push("inactive_object");
  if (stripeProduct.livemode || stripePrice.livemode) problems.push("live_mode_object");
  if (stripePrice.product !== stripeProduct.id) problems.push("price_product_mismatch");
  if (stripePrice.currency !== "myr") problems.push("currency_mismatch");
  if (stripePrice.unit_amount !== product.amount_sen) problems.push("amount_mismatch");
  if (!recurringIsCorrect) problems.push("billing_mode_mismatch");
  return problems;
}

async function fetchWebhookRejection(signature) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetch(`${STAGING_APP_URL}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature ? { "stripe-signature": signature } : {}),
        },
        body: "{}",
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`The webhook rejection check could not connect (${lastError?.cause?.code ?? "network_error"}).`);
}

const envPath = option("--env-file");
const configPath = option("--config");
const outputPath = option("--output");
const applyMetadata = process.argv.includes("--apply-metadata");
if (!envPath || !configPath || !outputPath) {
  throw new Error(
    "Usage: pnpm phase2:verify-stripe-staging --env-file /absolute/path/.env.staging.local --config /absolute/path/reviewed-config.json --output /absolute/private/path/stripe-evidence.json [--apply-metadata]",
  );
}

const repositoryRoot = resolve(".");
const resolvedOutputPath = resolve(outputPath);
if (
  resolvedOutputPath === repositoryRoot
  || resolvedOutputPath.startsWith(`${repositoryRoot}${sep}`)
) throw new Error("Stripe evidence must be written outside the repository.");

const envValues = parseEnvFile(await readFile(resolve(envPath), "utf8"));
const supabaseUrl = requireValue(envValues, "NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
const billingTarget = requireValue(envValues, "AIDO_BILLING_CONFIG_TARGET");
const stripeKey = requireValue(envValues, "STRIPE_SECRET_KEY");
const portalConfigurationId = requireValue(envValues, "STRIPE_PORTAL_CONFIGURATION_ID");
if (supabaseUrl !== STAGING_SUPABASE_URL || billingTarget !== "staging") {
  throw new Error("The Stripe verifier must target isolated AidoForMe staging exactly.");
}
if (!stripeKey.startsWith("sk_test_") && !stripeKey.startsWith("rk_test_")) {
  throw new Error("The Stripe verifier requires a Stripe test-mode key.");
}

const configBytes = await readFile(resolve(configPath));
const configuration = JSON.parse(configBytes.toString("utf8"));
const creditProducts = Array.isArray(configuration.credit_products)
  ? configuration.credit_products
  : [];
if (configuration.target_environment !== "staging" || creditProducts.length !== 2) {
  throw new Error("The reviewed configuration must contain exactly the two approved staging credit products.");
}
if (
  creditProducts.some((product) => (
    !["topup", "subscription"].includes(product.kind)
    || !Number.isInteger(product.amount_sen)
    || !Number.isInteger(product.credit_grant)
    || !Number.isInteger(product.expires_after_days)
    || !/^prod_[A-Za-z0-9]+$/.test(product.stripe_product_id)
    || !/^price_[A-Za-z0-9]+$/.test(product.stripe_price_id)
  ))
) throw new Error("A reviewed credit product has invalid values.");

const stripe = new Stripe(stripeKey);
const account = await stripe.accounts.retrieve();
if (account.id !== "acct_1Tv6yz1tdTVob40G") {
  throw new Error("The Stripe test key does not belong to the approved AidoForMe sandbox account.");
}

const catalog = [];
const pendingMetadataUpdates = [];
for (const product of creditProducts) {
  const [stripeProduct, stripePrice] = await Promise.all([
    stripe.products.retrieve(product.stripe_product_id),
    stripe.prices.retrieve(product.stripe_price_id),
  ]);
  const problems = structuralProblems(product, stripeProduct, stripePrice);
  if (problems.length) {
    throw new Error(`Stripe catalog structure failed for ${product.product_key}: ${problems.join(",")}.`);
  }
  const expected = expectedMetadata(product);
  if (!metadataMatches(stripeProduct.metadata, expected)) {
    pendingMetadataUpdates.push({
      object: "product",
      id: stripeProduct.id,
      expected,
      previous: stripeProduct.metadata,
    });
  }
  if (!metadataMatches(stripePrice.metadata, expected)) {
    pendingMetadataUpdates.push({
      object: "price",
      id: stripePrice.id,
      expected,
      previous: stripePrice.metadata,
    });
  }
  catalog.push({
    product_key: product.product_key,
    kind: product.kind,
    stripe_product_id: stripeProduct.id,
    stripe_price_id: stripePrice.id,
    amount_sen: stripePrice.unit_amount,
    credit_grant: product.credit_grant,
    expires_after_days: product.expires_after_days,
  });
}

if (pendingMetadataUpdates.length && !applyMetadata) {
  throw new Error(
    `Stripe metadata differs from the reviewed configuration on ${pendingMetadataUpdates.length} objects. Re-run with --apply-metadata after review.`,
  );
}
if (applyMetadata) {
  const appliedUpdates = [];
  try {
    for (const update of pendingMetadataUpdates) {
      await updateStripeMetadata(stripe, update, update.expected);
      appliedUpdates.push(update);
    }
    await assertCatalogReadback(stripe, creditProducts);
  } catch (error) {
    const rollbackFailures = [];
    for (const update of appliedUpdates.reverse()) {
      try {
        await updateStripeMetadata(
          stripe,
          update,
          restoreMetadataPatch(update.previous, update.expected),
        );
        const restored = await retrieveStripeMetadata(stripe, update);
        if (Object.keys(update.expected).some((key) => (
          restored?.[key] !== update.previous?.[key]
        ))) throw new Error("rollback_readback_mismatch");
      } catch {
        rollbackFailures.push(`${update.object}:${update.id}`);
      }
    }
    const rollback = rollbackFailures.length
      ? `rollback_failed=${rollbackFailures.join(",")}`
      : "rollback_completed";
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "metadata_update_failed";
    throw new Error(`Stripe metadata update failed (${code}; ${rollback}).`);
  }
} else {
  await assertCatalogReadback(stripe, creditProducts);
}

const portal = await stripe.billingPortal.configurations.retrieve(portalConfigurationId);
if (
  !portal.active
  || portal.livemode
  || portal.features.customer_update.enabled
  || !portal.features.invoice_history.enabled
  || !portal.features.payment_method_update.enabled
  || !portal.features.subscription_cancel.enabled
  || portal.features.subscription_cancel.mode !== "at_period_end"
  || portal.features.subscription_cancel.proration_behavior !== "none"
  || portal.features.subscription_pause.enabled
  || portal.features.subscription_update.enabled
) throw new Error("The Stripe portal configuration does not match the approved cancellation-only policy.");

const webhookList = await stripe.webhookEndpoints.list({ limit: 100 });
const expectedWebhookUrl = `${STAGING_APP_URL}/api/stripe/webhook`;
const matchingWebhooks = webhookList.data.filter((webhook) => webhook.url === expectedWebhookUrl);
if (
  matchingWebhooks.length !== 1
  || matchingWebhooks[0].status !== "enabled"
  || matchingWebhooks[0].livemode
  || !sameStrings(matchingWebhooks[0].enabled_events, EXPECTED_WEBHOOK_EVENTS)
) throw new Error("The Stripe webhook destination does not match the reviewed staging event contract.");

const [missingSignatureResponse, invalidSignatureResponse] = await Promise.all([
  fetchWebhookRejection(null),
  fetchWebhookRejection("t=1,v1=invalid"),
]);
if (missingSignatureResponse.status !== 400 || invalidSignatureResponse.status !== 400) {
  throw new Error("The deployed webhook did not reject missing and invalid Stripe signatures with HTTP 400.");
}

const evidence = {
  verified_at: new Date().toISOString(),
  target_environment: "staging",
  staging_project_ref: STAGING_PROJECT_REF,
  stripe_account_id: account.id,
  stripe_mode: "test",
  reviewed_configuration_sha256: createHash("sha256").update(configBytes).digest("hex"),
  metadata_updates_applied: pendingMetadataUpdates.map(({ object, id }) => ({ object, id })),
  catalog,
  portal: {
    id: portal.id,
    active: portal.active,
    cancellation_mode: portal.features.subscription_cancel.mode,
    proration_behavior: portal.features.subscription_cancel.proration_behavior,
    payment_method_update: portal.features.payment_method_update.enabled,
    invoice_history: portal.features.invoice_history.enabled,
    subscription_update: portal.features.subscription_update.enabled,
  },
  webhook: {
    id: matchingWebhooks[0].id,
    url: matchingWebhooks[0].url,
    status: matchingWebhooks[0].status,
    enabled_events: [...matchingWebhooks[0].enabled_events].sort(),
    missing_signature_http_status: missingSignatureResponse.status,
    invalid_signature_http_status: invalidSignatureResponse.status,
  },
  financial_lifecycle_event_created: false,
};

await mkdir(dirname(resolvedOutputPath), { recursive: true, mode: 0o700 });
await writeFile(resolvedOutputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(JSON.stringify({
  passed: true,
  ...evidence,
  private_evidence_path: resolvedOutputPath,
}, null, 2));
