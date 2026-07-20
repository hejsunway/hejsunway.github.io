import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: pnpm billing:import-provider-invoice /absolute/path/invoice.json");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) throw new Error("Supabase server credentials are not configured.");

const raw = await readFile(resolve(inputPath));
const input = JSON.parse(raw.toString("utf8"));
const requiredStrings = ["provider", "invoice_reference", "period_start", "period_end"];
for (const field of requiredStrings) {
  if (typeof input[field] !== "string" || !input[field].trim()) throw new Error(`${field} is required.`);
}
if (!Number.isSafeInteger(input.billed_microusd) || input.billed_microusd < 0) {
  throw new Error("billed_microusd must be a non-negative safe integer.");
}
const periodStart = new Date(input.period_start);
const periodEnd = new Date(input.period_end);
if (!Number.isFinite(periodStart.valueOf()) || !Number.isFinite(periodEnd.valueOf()) || periodEnd <= periodStart) {
  throw new Error("The provider invoice period is invalid.");
}
if (input.supersedes_invoice_id != null && typeof input.supersedes_invoice_id !== "string") {
  throw new Error("supersedes_invoice_id must be a UUID string when provided.");
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data, error } = await admin.from("aido_provider_invoice_imports").insert({
  provider: input.provider.trim(),
  invoice_reference: input.invoice_reference.trim(),
  period_start: periodStart.toISOString(),
  period_end: periodEnd.toISOString(),
  billed_microusd: input.billed_microusd,
  currency: "USD",
  source_sha256: createHash("sha256").update(raw).digest("hex"),
  supersedes_invoice_id: input.supersedes_invoice_id ?? null,
  imported_by: process.env.AIDO_ADMIN_USER_ID || null,
}).select("id,provider,invoice_reference,period_start,period_end,billed_microusd,source_sha256").single();
if (error) throw error;
console.log(JSON.stringify({ imported: data }, null, 2));
