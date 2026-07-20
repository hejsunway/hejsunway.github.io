import { createBillingAdminClient } from "@/lib/billing/admin";
import { isAuthorizedCronRequest } from "@/lib/internal/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

type ExpiryBatch = {
  selected_reservations: number;
  expired_reservations: number;
  selected_credit_lots: number;
  expired_credit_lots: number;
  failures: Array<{ entity_type: string; entity_id: string; code: string }>;
  has_more: boolean;
};

async function runMaintenance(request: Request) {
  if (!process.env.CRON_SECRET) return new Response("Maintenance is not configured.", { status: 503 });
  if (!isAuthorizedCronRequest(request)) return new Response("Unauthorized.", { status: 401 });

  const totals = {
    selected_reservations: 0,
    expired_reservations: 0,
    selected_credit_lots: 0,
    expired_credit_lots: 0,
  };
  const failures: ExpiryBatch["failures"] = [];
  let hasMore = false;

  for (let batch = 0; batch < 4; batch += 1) {
    const { data, error } = await createBillingAdminClient().rpc(
      "aido_expire_due_financial_state",
      { p_batch_limit: 500 },
    );
    if (error) throw error;
    const result = data as ExpiryBatch;
    totals.selected_reservations += result.selected_reservations;
    totals.expired_reservations += result.expired_reservations;
    totals.selected_credit_lots += result.selected_credit_lots;
    totals.expired_credit_lots += result.expired_credit_lots;
    failures.push(...result.failures);
    hasMore = result.has_more;
    if (!hasMore || result.failures.length > 0) break;
  }

  const body = { ...totals, failure_count: failures.length, failures, has_more: hasMore };
  if (failures.length > 0 || hasMore) {
    console.error("Aido financial maintenance requires review", body);
    return Response.json(body, { status: 500 });
  }
  return Response.json(body);
}

export async function GET(request: Request) {
  return runMaintenance(request);
}

export async function POST(request: Request) {
  return runMaintenance(request);
}
