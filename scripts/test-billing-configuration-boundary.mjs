import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const stagingRef = "vokjkogzvtohdinhxhkk";
const productionRef = "gmqlmqdqpytgjxolgrwq";
const effectiveFrom = "2026-07-20T00:00:00.000Z";
const billingConfigId = "10000000-0000-4000-8000-000000000001";
const providerPriceId = "10000000-0000-4000-8000-000000000002";
const rateCardId = "10000000-0000-4000-8000-000000000003";

const configuration = {
  configuration_label: "Phase 2 boundary regression fixture",
  target_environment: "staging",
  billing_config: {
    id: billingConfigId,
    version: 1,
    credits_per_retail_myr: 100,
    net_revenue_sen_per_1000_credits: 800,
    provider_cost_target_bps: 2000,
    quote_safety_multiplier_bps: 13500,
    payment_risk_reserve_bps: 500,
    budget_myr_sen_per_usd: 500,
    minimum_topup_sen: 2000,
    effective_from: effectiveFrom,
    effective_to: null,
  },
  provider_prices: [{
    id: providerPriceId,
    provider: "openai",
    model: "boundary-test-model",
    version: 1,
    input_microusd_per_million_tokens: 1_000_000,
    cached_input_microusd_per_million_tokens: 500_000,
    cache_write_input_microusd_per_million_tokens: 1_250_000,
    output_microusd_per_million_tokens: 2_000_000,
    tool_call_microusd: 0,
    search_call_microusd: 0,
    effective_from: effectiveFrom,
    effective_to: null,
    source_reference: "test-only boundary fixture",
  }],
  feature_rate_cards: [{
    id: rateCardId,
    feature_key: "boundary.test",
    version: 1,
    billing_config_id: billingConfigId,
    base_credits: 100,
    credits_per_1000_input_tokens: 0,
    credits_per_1000_output_tokens: 0,
    credits_per_page: 0,
    credits_per_source: 0,
    credits_per_search: 0,
    minimum_credits: 100,
    maximum_credits: 100,
    max_provider_cost_microusd: 1000,
    max_input_tokens: 10,
    max_output_tokens: 10,
    max_tool_calls: 0,
    max_search_calls: 0,
    max_pages: 1,
    max_sources: 0,
    max_retries: 0,
    timeout_ms: 1000,
    daily_user_credit_cap: 100,
    concurrent_job_cap: 1,
    effective_from: effectiveFrom,
    effective_to: null,
  }],
  provider_routes: [{
    id: "10000000-0000-4000-8000-000000000004",
    feature_rate_card_id: rateCardId,
    provider_price_id: providerPriceId,
    priority: 1,
    evaluation_reference: "test-only boundary fixture",
    privacy_policy_version: "test-only",
    approved: true,
    effective_from: effectiveFrom,
    effective_to: null,
  }],
  credit_products: [{
    id: "10000000-0000-4000-8000-000000000005",
    product_key: "boundary.topup",
    version: 1,
    kind: "topup",
    stripe_product_id: "prod_BoundaryTestOnly",
    stripe_price_id: "price_BoundaryTestOnly",
    amount_sen: 2000,
    credit_grant: 2000,
    expires_after_days: null,
    effective_from: effectiveFrom,
    effective_to: null,
  }],
  system_controls: [
    { scope_type: "global", scope_key: "*", is_enabled: true, daily_provider_budget_microusd: 1000, max_concurrent_calls: 1 },
    { scope_type: "feature", scope_key: "boundary.test", is_enabled: true, daily_provider_budget_microusd: 1000, max_concurrent_calls: 1 },
    { scope_type: "provider", scope_key: "openai", is_enabled: true, daily_provider_budget_microusd: 1000, max_concurrent_calls: 1 },
    { scope_type: "model", scope_key: "openai/boundary-test-model", is_enabled: true, daily_provider_budget_microusd: 1000, max_concurrent_calls: 1 },
  ],
};

const directory = await mkdtemp(join(tmpdir(), "aido-phase2-boundary-"));
const configPath = join(directory, "configuration.json");
const applyScript = resolve("scripts/apply-billing-configuration.mjs");
const preflightScript = resolve("scripts/phase-two-preflight.mjs");

try {
  await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });

  const validation = await execFileAsync(process.execPath, [applyScript, configPath]);
  assert.equal(JSON.parse(validation.stdout).valid, true);

  await assert.rejects(
    execFileAsync(process.execPath, [applyScript, configPath, "--apply"], {
      env: {
        ...process.env,
        AIDO_BILLING_CONFIG_TARGET: "staging",
        NEXT_PUBLIC_SUPABASE_URL: `https://${productionRef}.supabase.co`,
        SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-secret",
      },
    }),
    (error) => error.stderr.includes(
      `must exactly target the approved staging project (https://${stagingRef}.supabase.co)`,
    ),
  );

  let preflightError;
  try {
    await execFileAsync(process.execPath, [
      preflightScript,
      "--environment", "staging",
      "--project-ref", productionRef,
      "--config", configPath,
    ], {
      env: {
        ...process.env,
        AIDO_BILLING_CONFIG_TARGET: "staging",
        NEXT_PUBLIC_SUPABASE_URL: `https://${productionRef}.supabase.co`,
        SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-secret",
        STRIPE_SECRET_KEY: "sk_test_boundary",
        STRIPE_WEBHOOK_SECRET: "whsec_boundary",
        STRIPE_PORTAL_CONFIGURATION_ID: "bpc_boundary",
        CRON_SECRET: "test-only-not-a-secret",
        OPENAI_API_KEY: "test-only-not-a-secret",
      },
    });
  } catch (error) {
    preflightError = error;
  }
  assert.ok(preflightError, "preflight should reject a production ref declared as staging");
  const preflight = JSON.parse(preflightError.stdout);
  assert.equal(preflight.ready, false);
  assert.deepEqual(
    preflight.checks.find((check) => check.name === "environment_project_ref"),
    {
      name: "environment_project_ref",
      pass: false,
      detail: `expected ${stagingRef}`,
    },
  );

  console.log("Phase 2 environment/project boundary tests passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
