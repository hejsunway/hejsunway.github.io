import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createClient } from "@supabase/supabase-js";

const STAGING_PROJECT_REF = "vokjkogzvtohdinhxhkk";
const STAGING_SUPABASE_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
const STAGING_APP_URL = "https://aidofor-me-2afl.vercel.app";
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function responseJson(response, route) {
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new Error(`${route} returned a non-JSON response.`);
  }
  return body;
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

async function fetchReadOnlyWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetch(url, { method: "GET", redirect: "manual" });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`The read-only staging check could not connect (${lastError?.cause?.code ?? "network_error"}).`);
}

async function fetchMutatingOnce(url, cronSecret) {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${cronSecret}` },
    });
  } catch (error) {
    throw new Error(
      `The authenticated staging request had an ambiguous network result (${error?.cause?.code ?? "network_error"}); it was not retried.`,
    );
  }
}

const envPath = option("--env-file");
const outputPath = option("--output");
if (!envPath || !outputPath) {
  throw new Error(
    "Usage: pnpm phase2:verify-cron-staging --env-file /absolute/path/.env.staging.local --output /absolute/private/path/cron-evidence.json",
  );
}

const repositoryRoot = resolve(".");
const resolvedOutputPath = resolve(outputPath);
if (
  resolvedOutputPath === repositoryRoot
  || resolvedOutputPath.startsWith(`${repositoryRoot}${sep}`)
) throw new Error("Cron evidence must be written outside the repository.");

const fileValues = parseEnvFile(await readFile(resolve(envPath), "utf8"));
const supabaseUrl = requireValue(fileValues, "NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
const billingTarget = requireValue(fileValues, "AIDO_BILLING_CONFIG_TARGET");
const serviceRoleKey = requireValue(fileValues, "SUPABASE_SERVICE_ROLE_KEY");
const cronSecret = requireValue(fileValues, "CRON_SECRET");
const stripeKey = requireValue(fileValues, "STRIPE_SECRET_KEY");

if (supabaseUrl !== STAGING_SUPABASE_URL || billingTarget !== "staging") {
  throw new Error("The cron verifier must target isolated AidoForMe staging exactly.");
}
if (!stripeKey.startsWith("sk_test_") && !stripeKey.startsWith("rk_test_")) {
  throw new Error("The cron verifier requires a Stripe test-mode key.");
}

const routeNames = ["maintenance", "reconcile"];
const unauthorized = {};
for (const route of routeNames) {
  const response = await fetchReadOnlyWithRetry(`${STAGING_APP_URL}/api/internal/${route}`);
  unauthorized[route] = { status: response.status };
  if (response.status !== 401) {
    throw new Error(`${route} did not reject an unauthenticated request with HTTP 401.`);
  }
}

const maintenanceResponse = await fetchMutatingOnce(
  `${STAGING_APP_URL}/api/internal/maintenance`,
  cronSecret,
);
const maintenance = await responseJson(maintenanceResponse, "maintenance");
if (!maintenanceResponse.ok) throw new Error("Authenticated maintenance failed.");
for (const field of [
  "selected_reservations",
  "expired_reservations",
  "selected_credit_lots",
  "expired_credit_lots",
  "failure_count",
]) assertNonNegativeInteger(maintenance[field], `maintenance.${field}`);
if (
  maintenance.failure_count !== 0
  || !Array.isArray(maintenance.failures)
  || maintenance.failures.length !== 0
  || maintenance.has_more !== false
) throw new Error("Maintenance completed with unresolved work or failures.");

const reconcileResponse = await fetchMutatingOnce(
  `${STAGING_APP_URL}/api/internal/reconcile`,
  cronSecret,
);
const reconciliation = await responseJson(reconcileResponse, "reconcile");
if (
  !reconcileResponse.ok
  || reconciliation.status !== "completed"
  || !RUN_ID_PATTERN.test(reconciliation.run_id)
) throw new Error("Authenticated reconciliation did not return a completed run.");
assertNonNegativeInteger(reconciliation.issue_count, "reconciliation.issue_count");

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: run, error: runError } = await admin
  .from("aido_reconciliation_runs")
  .select("id,scope,status,internal_checked_count,stripe_checked_count,invoice_checked_count,issue_count,failure_code,started_at,completed_at")
  .eq("id", reconciliation.run_id)
  .single();
if (runError || !run) throw new Error("The reconciliation run was not persisted in staging.");
const issueCountResult = await admin
  .from("aido_reconciliation_run_issues")
  .select("id", { count: "exact", head: true })
  .eq("run_id", reconciliation.run_id);
if (issueCountResult.error) throw new Error("The reconciliation issue rows could not be verified.");

for (const field of [
  "internal_checked_count",
  "stripe_checked_count",
  "invoice_checked_count",
  "issue_count",
]) assertNonNegativeInteger(run[field], `run.${field}`);
if (
  run.scope !== "scheduled"
  || run.status !== "completed"
  || run.failure_code !== null
  || !run.completed_at
  || run.issue_count !== reconciliation.issue_count
  || issueCountResult.count !== reconciliation.issue_count
) throw new Error("The persisted reconciliation run does not match the route result.");

const evidence = {
  verified_at: new Date().toISOString(),
  target_environment: "staging",
  staging_project_ref: STAGING_PROJECT_REF,
  staging_app_url: STAGING_APP_URL,
  invocation_kind: "manual_authenticated_staging_verification",
  provider_request_made: false,
  stripe_mode: "test",
  unauthenticated_requests: unauthorized,
  maintenance: {
    http_status: maintenanceResponse.status,
    selected_reservations: maintenance.selected_reservations,
    expired_reservations: maintenance.expired_reservations,
    selected_credit_lots: maintenance.selected_credit_lots,
    expired_credit_lots: maintenance.expired_credit_lots,
    failure_count: maintenance.failure_count,
    has_more: maintenance.has_more,
  },
  reconciliation: {
    http_status: reconcileResponse.status,
    run_id: run.id,
    scope: run.scope,
    status: run.status,
    internal_checked_count: run.internal_checked_count,
    stripe_checked_count: run.stripe_checked_count,
    invoice_checked_count: run.invoice_checked_count,
    issue_count: run.issue_count,
    issue_row_count: issueCountResult.count,
    started_at: run.started_at,
    completed_at: run.completed_at,
  },
  scheduled_vercel_invocation_observed: false,
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
