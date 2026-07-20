import "server-only";

import { createBillingAdminClient } from "@/lib/billing/admin";
import { asSafeBigInt, toSafeNumber } from "@/lib/billing/integer-math";
import {
  calculateCreditsFromRate,
  calculateProviderCostMicrousd,
  type TrustedWorkEstimate,
} from "@/lib/billing/quote";
import { resolveProviderAdapter } from "@/lib/providers/registry";
import {
  ProviderProtocolError,
  type JsonObject,
  type ProviderFunctionTool,
  type ProviderMessage,
  type ProviderResult,
} from "@/lib/providers/types";

async function releaseFailedReservation(
  reservationId: string,
  idempotencyKey: string,
  category: string,
) {
  const admin = createBillingAdminClient();
  const { error } = await admin.rpc("aido_release_reservation", {
    p_reservation_id: reservationId,
    p_terminal_status: "failed",
    p_failure_category: category,
    p_idempotency_key: `${idempotencyKey}:release`,
  });
  if (error) throw error;
}

function transportFailureCategory(error: unknown): string {
  if (error instanceof ProviderProtocolError) return error.category;
  if (error instanceof Error && error.name === "AbortError") return "provider_timeout";
  return "provider_network_error";
}

function rpcRow<T>(data: T | T[] | null): T | null {
  return Array.isArray(data) ? data[0] ?? null : data;
}

/**
 * The only allowed runtime path to an AI provider.
 *
 * The reservation snapshot chooses the provider and exact model. Feature code
 * supplies content and a trusted estimate, but cannot override routing,
 * pricing, timeouts, or financial ceilings.
 */
export async function runMeteredProviderResponse<T>(input: {
  reservationId: string;
  callIdempotencyKey: string;
  usageIdempotencyKey: string;
  settlementIdempotencyKey: string;
  promptVersion: string;
  attempt: number;
  estimated: TrustedWorkEstimate;
  instructions: string;
  messages: ProviderMessage[];
  tools?: ProviderFunctionTool[];
  validate: (result: { response: JsonObject; text: string }) => Promise<T>;
}): Promise<{
  artifact: T;
  responseId: string | null;
  usage: TrustedWorkEstimate & { cachedInputTokens: number };
}> {
  const admin = createBillingAdminClient();
  const { data: reservation, error: reservationError } = await admin
    .from("aido_usage_reservations")
    .select("*,aido_feature_rate_cards(*),aido_provider_routes(*,aido_provider_prices(*))")
    .eq("id", input.reservationId)
    .single();
  if (reservationError || !reservation) throw reservationError ?? new Error("Reservation not found.");

  const rate = reservation.aido_feature_rate_cards as JsonObject;
  const route = reservation.aido_provider_routes as JsonObject;
  const price = route?.aido_provider_prices as JsonObject;
  if (!rate || !route || !price) throw new Error("Reservation pricing snapshot is incomplete.");
  const trustedEstimatedCost = calculateProviderCostMicrousd(price, input.estimated);

  let adapter;
  try {
    adapter = resolveProviderAdapter(String(price.provider));
  } catch (error) {
    await releaseFailedReservation(
      input.reservationId,
      input.callIdempotencyKey,
      "provider_not_configured",
    );
    throw error;
  }

  const { error: runningError } = await admin.rpc("aido_mark_reservation_running", {
    p_reservation_id: input.reservationId,
  });
  if (runningError) throw runningError;

  const authorizationExpiry = new Date(
    Date.now() + Math.min(Number(rate.timeout_ms) + 60_000, 30 * 60_000),
  ).toISOString();
  const { data: authorizationData, error: authorizationError } = await admin.rpc(
    "aido_authorize_provider_call",
    {
      p_reservation_id: input.reservationId,
      p_idempotency_key: input.callIdempotencyKey,
      p_attempt: input.attempt,
      p_estimated_cost_microusd: toSafeNumber(trustedEstimatedCost, "estimated provider cost"),
      p_estimated_input_tokens: input.estimated.inputTokens,
      p_estimated_output_tokens: input.estimated.outputTokens,
      p_estimated_tool_calls: input.estimated.toolCalls,
      p_estimated_search_calls: input.estimated.searches,
      p_estimated_pages: input.estimated.pages,
      p_expires_at: authorizationExpiry,
    },
  );
  if (authorizationError) throw authorizationError;
  const authorization = rpcRow(authorizationData);
  if (!authorization?.id || authorization.status !== "authorized") {
    throw new Error("Provider call was already finalized; load the persisted job result.");
  }

  const { data: dispatchClaim, error: dispatchError } = await admin.rpc(
    "aido_mark_provider_call_dispatched",
    { p_authorization_id: authorization.id },
  );
  if (dispatchError) throw dispatchError;
  if (dispatchClaim !== true) {
    throw new Error(
      "Provider dispatch already started. The job must reconcile its persisted result before retrying.",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(rate.timeout_ms));
  const startedAt = Date.now();
  let result: ProviderResult;
  try {
    result = await adapter.execute({
      model: String(price.model),
      instructions: input.instructions,
      messages: input.messages,
      tools: input.tools ?? [],
      maxOutputTokens: input.estimated.outputTokens,
      idempotencyKey: input.callIdempotencyKey,
      signal: controller.signal,
    });
  } catch (error) {
    // Once dispatched, a timeout, network failure, or malformed response is
    // financially ambiguous. Releasing and retrying immediately could pay the
    // provider twice. The expired dispatch is instead surfaced by scheduled
    // reconciliation and the reservation remains fail-closed meanwhile.
    const category = transportFailureCategory(error);
    throw new Error(`Provider dispatch requires reconciliation: ${category}.`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  const actual = {
    inputTokens: result.usage.inputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    outputTokens: result.usage.outputTokens,
    pages: input.estimated.pages,
    sources: input.estimated.sources,
    toolCalls: result.usage.toolCalls,
    searches: result.usage.searches,
  };
  const actualProviderCost = calculateProviderCostMicrousd(price, actual);
  const usageWithinAuthorization =
    actual.inputTokens <= input.estimated.inputTokens
    && actual.outputTokens <= input.estimated.outputTokens
    && actual.toolCalls <= input.estimated.toolCalls
    && actual.searches <= input.estimated.searches
    && actualProviderCost <= trustedEstimatedCost;

  let artifact: T | null = null;
  let validationError: unknown;
  if (result.completed && usageWithinAuthorization) {
    try {
      artifact = await input.validate({ response: result.raw, text: result.text });
    } catch (error) {
      validationError = error;
    }
  }
  const succeeded = result.completed && usageWithinAuthorization && validationError === undefined;
  const failureCategory = succeeded
    ? null
    : !usageWithinAuthorization
      ? "provider_usage_exceeded_authorization"
      : validationError === undefined
        ? result.failureCategory ?? "provider_incomplete_response"
        : "output_validation_failed";

  const { error: usageError } = await admin.rpc("aido_record_usage_event", {
    p_authorization_id: authorization.id,
    p_idempotency_key: input.usageIdempotencyKey,
    p_provider_request_id: result.responseId,
    p_prompt_version: input.promptVersion,
    p_input_tokens: actual.inputTokens,
    p_cached_input_tokens: actual.cachedInputTokens,
    p_output_tokens: actual.outputTokens,
    p_tool_calls: actual.toolCalls,
    p_search_calls: actual.searches,
    p_processed_pages: actual.pages,
    p_latency_ms: Date.now() - startedAt,
    p_provider_cost_microusd: toSafeNumber(actualProviderCost, "actual provider cost"),
    p_outcome: succeeded ? "succeeded" : "failed",
    p_billable_to_student: succeeded,
    p_failure_category: failureCategory,
  });
  if (usageError) throw usageError;

  if (!succeeded) {
    await releaseFailedReservation(input.reservationId, input.callIdempotencyKey, failureCategory!);
    if (validationError !== undefined) throw validationError;
    throw new Error(`Provider response failed: ${failureCategory}.`);
  }

  const capture = calculateCreditsFromRate(rate, actual);
  const maximum = asSafeBigInt(reservation.maximum_credits, "reservation maximum");
  if (capture > maximum) {
    await releaseFailedReservation(
      input.reservationId,
      input.callIdempotencyKey,
      "actual_charge_exceeded_reservation",
    );
    throw new Error("Actual credit charge exceeded the reserved maximum.");
  }
  const { error: settleError } = await admin.rpc("aido_settle_reservation", {
    p_reservation_id: input.reservationId,
    p_capture_credits: toSafeNumber(capture, "captured credits"),
    p_idempotency_key: input.settlementIdempotencyKey,
  });
  if (settleError) throw settleError;

  return {
    artifact: artifact as T,
    responseId: result.responseId,
    usage: actual,
  };
}
