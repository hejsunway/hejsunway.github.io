import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const ENVIRONMENT_PROJECT_REFS = Object.freeze({
  staging: "vokjkogzvtohdinhxhkk",
  production: "gmqlmqdqpytgjxolgrwq",
});
const inputPath = args.find((arg) => !arg.startsWith("--"));
const shouldApply = args.includes("--apply");
const confirmProduction = args.includes("--confirm-production");
if (!inputPath) {
  throw new Error(
    "Usage: pnpm billing:config /absolute/path/config.json [--apply] [--confirm-production]",
  );
}

const raw = await readFile(resolve(inputPath));
let configuration;
try {
  configuration = JSON.parse(raw.toString("utf8"));
} catch {
  throw new Error("Billing configuration must be valid JSON.");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEATURE_KEY = /^[a-z][a-z0-9_.-]{2,79}$/;
const STRIPE_PRODUCT = /^prod_[A-Za-z0-9]+$/;
const STRIPE_PRICE = /^price_[A-Za-z0-9]+$/;
const PROVIDERS = new Set(["openai", "deepseek", "minimax"]);

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
}

function exactKeys(value, required, optional, path) {
  object(value, path);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length) throw new Error(`${path} has unknown fields: ${unknown.join(", ")}.`);
  if (missing.length) throw new Error(`${path} is missing fields: ${missing.join(", ")}.`);
}

function string(value, path, pattern) {
  if (typeof value !== "string" || !value.trim() || (pattern && !pattern.test(value))) {
    throw new Error(`${path} is invalid.`);
  }
  return value;
}

function integer(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function boolean(value, path) {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean.`);
  return value;
}

function instant(value, path, nullable = false) {
  if (nullable && value === null) return null;
  string(value, path);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${path} must be an ISO-8601 UTC instant.`);
  }
  return value;
}

function array(value, path) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${path} must be a non-empty array.`);
  return value;
}

function unique(rows, field, path) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row[field])) throw new Error(`${path} has duplicate ${field}: ${row[field]}.`);
    seen.add(row[field]);
  }
}

function ceilDiv(left, right) {
  return (left + right - 1n) / right;
}

exactKeys(
  configuration,
  [
    "configuration_label", "target_environment", "billing_config",
    "provider_prices", "feature_rate_cards", "provider_routes",
    "credit_products", "system_controls",
  ],
  [],
  "configuration",
);
string(configuration.configuration_label, "configuration.configuration_label");
if (!new Set(["staging", "production"]).has(configuration.target_environment)) {
  throw new Error("configuration.target_environment must be staging or production.");
}

const config = object(configuration.billing_config, "configuration.billing_config");
const configFields = [
  "id", "version", "credits_per_retail_myr", "net_revenue_sen_per_1000_credits",
  "provider_cost_target_bps", "quote_safety_multiplier_bps", "payment_risk_reserve_bps",
  "budget_myr_sen_per_usd", "minimum_topup_sen", "effective_from", "effective_to",
];
exactKeys(config, configFields, [], "configuration.billing_config");
string(config.id, "billing_config.id", UUID);
integer(config.version, "billing_config.version", 1);
integer(config.credits_per_retail_myr, "billing_config.credits_per_retail_myr", 1);
integer(config.net_revenue_sen_per_1000_credits, "billing_config.net_revenue_sen_per_1000_credits", 1);
integer(config.provider_cost_target_bps, "billing_config.provider_cost_target_bps", 1, 10000);
integer(config.quote_safety_multiplier_bps, "billing_config.quote_safety_multiplier_bps", 10000);
integer(config.payment_risk_reserve_bps, "billing_config.payment_risk_reserve_bps", 0, 10000);
integer(config.budget_myr_sen_per_usd, "billing_config.budget_myr_sen_per_usd", 1);
integer(config.minimum_topup_sen, "billing_config.minimum_topup_sen", 1);
instant(config.effective_from, "billing_config.effective_from");
instant(config.effective_to, "billing_config.effective_to", true);

const prices = array(configuration.provider_prices, "configuration.provider_prices");
const priceFields = [
  "id", "provider", "model", "version", "input_microusd_per_million_tokens",
  "cached_input_microusd_per_million_tokens", "output_microusd_per_million_tokens",
  "tool_call_microusd", "search_call_microusd", "effective_from", "effective_to",
  "source_reference",
];
for (const [index, price] of prices.entries()) {
  const path = `provider_prices[${index}]`;
  exactKeys(price, priceFields, [], path);
  string(price.id, `${path}.id`, UUID);
  string(price.provider, `${path}.provider`);
  if (!PROVIDERS.has(price.provider)) throw new Error(`${path}.provider is not supported by the gateway.`);
  string(price.model, `${path}.model`);
  integer(price.version, `${path}.version`, 1);
  for (const field of priceFields.filter((field) => field.endsWith("microusd_per_million_tokens") || field.endsWith("_microusd"))) {
    integer(price[field], `${path}.${field}`);
  }
  if (
    price.input_microusd_per_million_tokens
    + price.cached_input_microusd_per_million_tokens
    + price.output_microusd_per_million_tokens
    + price.tool_call_microusd
    + price.search_call_microusd === 0
  ) throw new Error(`${path} must contain at least one non-zero provider cost.`);
  instant(price.effective_from, `${path}.effective_from`);
  instant(price.effective_to, `${path}.effective_to`, true);
  string(price.source_reference, `${path}.source_reference`);
}
unique(prices, "id", "provider_prices");

const rates = array(configuration.feature_rate_cards, "configuration.feature_rate_cards");
const rateFields = [
  "id", "feature_key", "version", "billing_config_id", "base_credits",
  "credits_per_1000_input_tokens", "credits_per_1000_output_tokens", "credits_per_page",
  "credits_per_source", "credits_per_search", "minimum_credits", "maximum_credits",
  "max_provider_cost_microusd", "max_input_tokens", "max_output_tokens", "max_tool_calls",
  "max_search_calls", "max_pages", "max_sources", "max_retries", "timeout_ms",
  "daily_user_credit_cap", "concurrent_job_cap", "effective_from", "effective_to",
];
for (const [index, rate] of rates.entries()) {
  const path = `feature_rate_cards[${index}]`;
  exactKeys(rate, rateFields, [], path);
  string(rate.id, `${path}.id`, UUID);
  string(rate.feature_key, `${path}.feature_key`, FEATURE_KEY);
  string(rate.billing_config_id, `${path}.billing_config_id`, UUID);
  if (rate.billing_config_id !== config.id) throw new Error(`${path} references another billing configuration.`);
  integer(rate.version, `${path}.version`, 1);
  for (const field of [
    "base_credits", "credits_per_1000_input_tokens", "credits_per_1000_output_tokens",
    "credits_per_page", "credits_per_source", "credits_per_search", "max_tool_calls",
    "max_search_calls", "max_pages", "max_sources", "max_retries",
  ]) integer(rate[field], `${path}.${field}`);
  for (const field of [
    "minimum_credits", "maximum_credits", "max_provider_cost_microusd", "max_input_tokens",
    "max_output_tokens", "timeout_ms", "daily_user_credit_cap", "concurrent_job_cap",
  ]) integer(rate[field], `${path}.${field}`, 1);
  if (rate.maximum_credits < rate.minimum_credits) throw new Error(`${path}.maximum_credits is below minimum_credits.`);
  if (rate.daily_user_credit_cap < rate.maximum_credits) throw new Error(`${path}.daily_user_credit_cap is below maximum_credits.`);
  if (rate.max_retries > 10 || rate.timeout_ms > 3_600_000 || rate.concurrent_job_cap > 100) {
    throw new Error(`${path} exceeds a database hard limit.`);
  }
  instant(rate.effective_from, `${path}.effective_from`);
  instant(rate.effective_to, `${path}.effective_to`, true);

  const minimumNetSen = ceilDiv(
    BigInt(rate.minimum_credits) * BigInt(config.net_revenue_sen_per_1000_credits),
    1000n,
  );
  const providerTargetSen = minimumNetSen * BigInt(config.provider_cost_target_bps) / 10000n;
  const marginBudget = providerTargetSen * 1_000_000n / BigInt(config.budget_myr_sen_per_usd);
  if (BigInt(rate.max_provider_cost_microusd) > marginBudget) {
    throw new Error(`${path} violates the minimum-charge provider margin (${marginBudget} microusd maximum).`);
  }
}
unique(rates, "id", "feature_rate_cards");

const priceById = new Map(prices.map((row) => [row.id, row]));
const rateById = new Map(rates.map((row) => [row.id, row]));
const routes = array(configuration.provider_routes, "configuration.provider_routes");
const routeFields = [
  "id", "feature_rate_card_id", "provider_price_id", "priority", "evaluation_reference",
  "privacy_policy_version", "approved", "effective_from", "effective_to",
];
for (const [index, route] of routes.entries()) {
  const path = `provider_routes[${index}]`;
  exactKeys(route, routeFields, [], path);
  string(route.id, `${path}.id`, UUID);
  string(route.feature_rate_card_id, `${path}.feature_rate_card_id`, UUID);
  string(route.provider_price_id, `${path}.provider_price_id`, UUID);
  integer(route.priority, `${path}.priority`, 1, 1000);
  string(route.evaluation_reference, `${path}.evaluation_reference`);
  string(route.privacy_policy_version, `${path}.privacy_policy_version`);
  boolean(route.approved, `${path}.approved`);
  instant(route.effective_from, `${path}.effective_from`);
  instant(route.effective_to, `${path}.effective_to`, true);
  const rate = rateById.get(route.feature_rate_card_id);
  const price = priceById.get(route.provider_price_id);
  if (!rate || !price) throw new Error(`${path} must reference rows in the same configuration.`);
  if (route.approved) {
    const maximumCost =
      ceilDiv(BigInt(rate.max_input_tokens) * BigInt(Math.max(
        price.input_microusd_per_million_tokens,
        price.cached_input_microusd_per_million_tokens,
      )), 1_000_000n)
      + ceilDiv(BigInt(rate.max_output_tokens) * BigInt(price.output_microusd_per_million_tokens), 1_000_000n)
      + BigInt(rate.max_tool_calls) * BigInt(price.tool_call_microusd)
      + BigInt(rate.max_search_calls) * BigInt(price.search_call_microusd);
    if (maximumCost > BigInt(rate.max_provider_cost_microusd)) {
      throw new Error(`${path} costs ${maximumCost} microusd at its hard limits, above the rate ceiling.`);
    }
  }
}
unique(routes, "id", "provider_routes");
for (const rate of rates) {
  if (!routes.some((route) => route.feature_rate_card_id === rate.id && route.approved)) {
    throw new Error(`Rate card ${rate.feature_key} has no approved provider route.`);
  }
}

const products = array(configuration.credit_products, "configuration.credit_products");
const productFields = [
  "id", "product_key", "version", "kind", "stripe_product_id", "stripe_price_id",
  "amount_sen", "credit_grant", "expires_after_days", "effective_from", "effective_to",
];
for (const [index, product] of products.entries()) {
  const path = `credit_products[${index}]`;
  exactKeys(product, productFields, [], path);
  string(product.id, `${path}.id`, UUID);
  string(product.product_key, `${path}.product_key`, FEATURE_KEY);
  integer(product.version, `${path}.version`, 1);
  if (!["topup", "subscription", "semester", "promotion"].includes(product.kind)) {
    throw new Error(`${path}.kind is invalid.`);
  }
  string(product.stripe_product_id, `${path}.stripe_product_id`, STRIPE_PRODUCT);
  string(product.stripe_price_id, `${path}.stripe_price_id`, STRIPE_PRICE);
  integer(product.amount_sen, `${path}.amount_sen`, 1);
  integer(product.credit_grant, `${path}.credit_grant`, 1);
  if (product.expires_after_days !== null) integer(product.expires_after_days, `${path}.expires_after_days`, 1, 3650);
  instant(product.effective_from, `${path}.effective_from`);
  instant(product.effective_to, `${path}.effective_to`, true);
  if (product.kind === "topup" && product.amount_sen < config.minimum_topup_sen) {
    throw new Error(`${path}.amount_sen is below the configured minimum top-up.`);
  }
  const retailGrant = BigInt(product.amount_sen) * BigInt(config.credits_per_retail_myr) / 100n;
  const riskAdjustedSen = BigInt(product.amount_sen) * BigInt(10000 - config.payment_risk_reserve_bps) / 10000n;
  const requiredNetSen = ceilDiv(
    BigInt(product.credit_grant) * BigInt(config.net_revenue_sen_per_1000_credits),
    1000n,
  );
  if (BigInt(product.credit_grant) > retailGrant || requiredNetSen > riskAdjustedSen) {
    throw new Error(`${path} does not fully fund its promised credits.`);
  }
}
unique(products, "id", "credit_products");
unique(products, "stripe_price_id", "credit_products");

const controls = array(configuration.system_controls, "configuration.system_controls");
const controlFields = [
  "scope_type", "scope_key", "is_enabled", "daily_provider_budget_microusd",
  "max_concurrent_calls",
];
const controlKeys = new Set();
for (const [index, control] of controls.entries()) {
  const path = `system_controls[${index}]`;
  exactKeys(control, controlFields, [], path);
  if (!["global", "feature", "provider", "model"].includes(control.scope_type)) {
    throw new Error(`${path}.scope_type is invalid.`);
  }
  string(control.scope_key, `${path}.scope_key`);
  boolean(control.is_enabled, `${path}.is_enabled`);
  integer(control.daily_provider_budget_microusd, `${path}.daily_provider_budget_microusd`);
  integer(control.max_concurrent_calls, `${path}.max_concurrent_calls`, 0, 10000);
  const key = `${control.scope_type}:${control.scope_key}`;
  if (controlKeys.has(key)) throw new Error(`Duplicate system control ${key}.`);
  controlKeys.add(key);
}
for (const route of routes.filter((row) => row.approved)) {
  const rate = rateById.get(route.feature_rate_card_id);
  const price = priceById.get(route.provider_price_id);
  for (const key of [
    "global:*",
    `feature:${rate.feature_key}`,
    `provider:${price.provider}`,
    `model:${price.provider}/${price.model}`,
  ]) {
    if (!controlKeys.has(key)) throw new Error(`Approved route is missing system control ${key}.`);
  }
}

const digest = createHash("sha256").update(raw).digest("hex");
const summary = {
  valid: true,
  source_sha256: digest,
  target_environment: configuration.target_environment,
  billing_version: config.version,
  providers: [...new Set(prices.map((row) => row.provider))].sort(),
  provider_prices: prices.length,
  rate_cards: rates.length,
  approved_routes: routes.filter((row) => row.approved).length,
  credit_products: products.length,
  system_controls: controls.length,
};

if (!shouldApply) {
  console.log(JSON.stringify({ ...summary, applied: false }, null, 2));
  process.exit(0);
}

const target = process.env.AIDO_BILLING_CONFIG_TARGET;
if (target !== configuration.target_environment) {
  throw new Error("AIDO_BILLING_CONFIG_TARGET must exactly match configuration.target_environment.");
}
if (target === "production" && !confirmProduction) {
  throw new Error("Production import requires the explicit --confirm-production flag.");
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error("Supabase server credentials are required for --apply.");
const expectedProjectRef = ENVIRONMENT_PROJECT_REFS[target];
const expectedOrigin = `https://${expectedProjectRef}.supabase.co`;
let configuredOrigin;
try {
  configuredOrigin = new URL(url).origin;
} catch {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid absolute URL.");
}
if (configuredOrigin !== expectedOrigin) {
  throw new Error(
    `NEXT_PUBLIC_SUPABASE_URL must exactly target the approved ${target} project (${expectedOrigin}).`,
  );
}
const appliedBy = process.env.AIDO_ADMIN_USER_ID || null;
if (appliedBy !== null && !UUID.test(appliedBy)) throw new Error("AIDO_ADMIN_USER_ID must be a UUID.");

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data, error } = await admin.rpc("aido_apply_billing_configuration", {
  p_configuration: configuration,
  p_source_sha256: digest,
  p_applied_by: appliedBy,
});
if (error) throw error;
console.log(JSON.stringify({ ...summary, applied: true, import_id: data }, null, 2));
