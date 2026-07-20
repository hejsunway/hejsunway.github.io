import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const ENVIRONMENT_PROJECT_REFS = Object.freeze({
  staging: "vokjkogzvtohdinhxhkk",
  production: "gmqlmqdqpytgjxolgrwq",
});

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const environment = option("--environment");
const projectRef = option("--project-ref");
const configPath = option("--config");
if (!new Set(["staging", "production"]).has(environment) || !projectRef || !configPath) {
  throw new Error(
    "Usage: pnpm phase2:preflight --environment staging|production --project-ref <ref> --config /absolute/path/reviewed-config.json",
  );
}
if (!/^[a-z0-9]{20}$/.test(projectRef)) throw new Error("--project-ref is invalid.");

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}
function present(name) {
  const pass = typeof process.env[name] === "string" && process.env[name].length > 0;
  check(name, pass, pass ? "set" : "missing");
  return pass;
}

let configuration;
try {
  const raw = await readFile(resolve(configPath), "utf8");
  configuration = JSON.parse(raw);
  const { stdout } = await execFileAsync(process.execPath, [
    resolve("scripts/apply-billing-configuration.mjs"),
    resolve(configPath),
  ]);
  const validation = JSON.parse(stdout);
  check("billing_configuration", validation.valid === true, "valid");
} catch (error) {
  check(
    "billing_configuration",
    false,
    error instanceof Error ? error.message.split("\n")[0] : "validation failed",
  );
}

check(
  "configuration_target",
  configuration?.target_environment === environment,
  configuration?.target_environment === environment
    ? environment
    : `expected ${environment}`,
);

const expectedProjectRef = ENVIRONMENT_PROJECT_REFS[environment];
check(
  "environment_project_ref",
  projectRef === expectedProjectRef,
  projectRef === expectedProjectRef
    ? "approved project match"
    : `expected ${expectedProjectRef}`,
);
check(
  "AIDO_BILLING_CONFIG_TARGET",
  process.env.AIDO_BILLING_CONFIG_TARGET === environment,
  process.env.AIDO_BILLING_CONFIG_TARGET === environment
    ? environment
    : `missing or expected ${environment}`,
);

const expectedUrl = `https://${projectRef}.supabase.co`;
const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
check(
  "NEXT_PUBLIC_SUPABASE_URL",
  configuredUrl === expectedUrl,
  configuredUrl === expectedUrl ? "exact project match" : "missing or another project",
);
present("SUPABASE_SERVICE_ROLE_KEY");

const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
const expectedStripePrefix = environment === "staging"
  ? ["sk_test_", "rk_test_"]
  : ["sk_live_", "rk_live_"];
check(
  "STRIPE_SECRET_KEY",
  expectedStripePrefix.some((prefix) => stripeKey.startsWith(prefix)),
  stripeKey
    ? `must be ${environment === "staging" ? "test" : "live"} mode`
    : "missing",
);
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
check(
  "STRIPE_WEBHOOK_SECRET",
  stripeWebhookSecret.startsWith("whsec_") && stripeWebhookSecret.length > "whsec_".length,
  stripeWebhookSecret ? "invalid webhook-signing secret" : "missing",
);
const stripePortalConfigurationId = process.env.STRIPE_PORTAL_CONFIGURATION_ID ?? "";
check(
  "STRIPE_PORTAL_CONFIGURATION_ID",
  stripePortalConfigurationId.startsWith("bpc_")
    && stripePortalConfigurationId.length > "bpc_".length,
  stripePortalConfigurationId ? "invalid portal configuration ID" : "missing",
);
present("CRON_SECRET");

const providerVariables = {
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  minimax: "MINIMAX_API_KEY",
};
const approvedPriceIds = new Set(
  Array.isArray(configuration?.provider_routes)
    ? configuration.provider_routes
      .filter((route) => route?.approved === true)
      .map((route) => route.provider_price_id)
    : [],
);
const approvedProviders = new Set(
  Array.isArray(configuration?.provider_prices)
    ? configuration.provider_prices
      .filter((price) => approvedPriceIds.has(price?.id))
      .map((price) => price.provider)
    : [],
);
for (const provider of approvedProviders) {
  const variable = providerVariables[provider];
  if (variable) present(variable);
}
if (approvedProviders.size === 0) {
  check("approved_provider_credentials", false, "configuration has no approved route");
}

const failed = checks.filter((item) => !item.pass);
console.log(JSON.stringify({
  environment,
  project_ref: projectRef,
  ready: failed.length === 0,
  checks,
}, null, 2));
if (failed.length) process.exitCode = 1;
