import "server-only";

import { createBillingAdminClient } from "@/lib/billing/admin";
import { asSafeBigInt, ceilDiv, toSafeNumber } from "@/lib/billing/integer-math";

export type TrustedWorkEstimate = {
  inputTokens: number;
  outputTokens: number;
  pages: number;
  sources: number;
  searches: number;
  toolCalls: number;
};

export type MeteredQuote = {
  featureKey: string;
  featureRateCardId: string;
  providerRouteId: string;
  provider: string;
  model: string;
  quotedCredits: number;
  maximumCredits: number;
  estimatedProviderCostMicrousd: number;
  providerBudgetMicrousd: number;
  limits: TrustedWorkEstimate & { retries: number; timeoutMs: number };
};

type RateRow = Record<string, unknown>;
type PriceRow = Record<string, unknown>;

function assertEstimate(estimate: TrustedWorkEstimate) {
  for (const [key, value] of Object.entries(estimate)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid trusted estimate: ${key}.`);
  }
}

function units(value: number): bigint {
  return BigInt(value);
}

export function calculateCreditsFromRate(rate: RateRow, estimate: TrustedWorkEstimate): bigint {
  const raw =
    asSafeBigInt(rate.base_credits, "base credits") +
    ceilDiv(units(estimate.inputTokens), BigInt(1000)) * asSafeBigInt(rate.credits_per_1000_input_tokens, "input credits") +
    ceilDiv(units(estimate.outputTokens), BigInt(1000)) * asSafeBigInt(rate.credits_per_1000_output_tokens, "output credits") +
    units(estimate.pages) * asSafeBigInt(rate.credits_per_page, "page credits") +
    units(estimate.sources) * asSafeBigInt(rate.credits_per_source, "source credits") +
    units(estimate.searches) * asSafeBigInt(rate.credits_per_search, "search credits");
  return raw > asSafeBigInt(rate.minimum_credits, "minimum credits")
    ? raw
    : asSafeBigInt(rate.minimum_credits, "minimum credits");
}

export function calculateProviderCostMicrousd(
  price: PriceRow,
  usage: TrustedWorkEstimate & {
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  },
): bigint {
  const cached = units(usage.cachedInputTokens ?? 0);
  const cacheWrite = units(usage.cacheWriteInputTokens ?? 0);
  const input = units(usage.inputTokens);
  if (cached + cacheWrite > input) {
    throw new Error("Cache-read and cache-write input cannot exceed total input.");
  }
  return (
    ceilDiv((input - cached - cacheWrite) * asSafeBigInt(price.input_microusd_per_million_tokens, "input price"), BigInt(1_000_000)) +
    ceilDiv(cached * asSafeBigInt(price.cached_input_microusd_per_million_tokens, "cached input price"), BigInt(1_000_000)) +
    ceilDiv(cacheWrite * asSafeBigInt(price.cache_write_input_microusd_per_million_tokens, "cache-write input price"), BigInt(1_000_000)) +
    ceilDiv(units(usage.outputTokens) * asSafeBigInt(price.output_microusd_per_million_tokens, "output price"), BigInt(1_000_000)) +
    units(usage.toolCalls) * asSafeBigInt(price.tool_call_microusd, "tool price") +
    units(usage.searches) * asSafeBigInt(price.search_call_microusd, "search price")
  );
}

export function calculateMaximumProviderCostMicrousd(
  price: PriceRow,
  usage: TrustedWorkEstimate,
): bigint {
  const maximumInputPrice = [
    price.input_microusd_per_million_tokens,
    price.cached_input_microusd_per_million_tokens,
    price.cache_write_input_microusd_per_million_tokens,
  ].map((value) => asSafeBigInt(value, "input price"))
    .reduce((maximum, value) => value > maximum ? value : maximum);
  return (
    ceilDiv(units(usage.inputTokens) * maximumInputPrice, BigInt(1_000_000)) +
    ceilDiv(units(usage.outputTokens) * asSafeBigInt(price.output_microusd_per_million_tokens, "output price"), BigInt(1_000_000)) +
    units(usage.toolCalls) * asSafeBigInt(price.tool_call_microusd, "tool price") +
    units(usage.searches) * asSafeBigInt(price.search_call_microusd, "search price")
  );
}

export async function quoteMeteredWork(
  featureKey: string,
  estimate: TrustedWorkEstimate,
): Promise<MeteredQuote> {
  assertEstimate(estimate);
  const admin = createBillingAdminClient();
  const now = new Date().toISOString();
  const { data: rate, error: rateError } = await admin
    .from("aido_feature_rate_cards")
    .select("*")
    .eq("feature_key", featureKey)
    .lte("effective_from", now)
    .or(`effective_to.is.null,effective_to.gt.${now}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rateError || !rate) throw rateError ?? new Error("No effective feature rate card.");

  const { data: route, error: routeError } = await admin
    .from("aido_provider_routes")
    .select("*,aido_provider_prices(*)")
    .eq("feature_rate_card_id", rate.id)
    .eq("approved", true)
    .lte("effective_from", now)
    .or(`effective_to.is.null,effective_to.gt.${now}`)
    .order("priority", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (routeError || !route) throw routeError ?? new Error("No approved provider route.");
  const price = route.aido_provider_prices as PriceRow | null;
  if (!price) throw new Error("The approved provider route has no price version.");

  const { data: config, error: configError } = await admin
    .from("aido_billing_config_versions")
    .select("*")
    .eq("id", rate.billing_config_id)
    .single();
  if (configError || !config) throw configError ?? new Error("Billing configuration is missing.");

  const limitPairs: Array<[keyof TrustedWorkEstimate, string]> = [
    ["inputTokens", "max_input_tokens"], ["outputTokens", "max_output_tokens"],
    ["pages", "max_pages"], ["sources", "max_sources"],
    ["searches", "max_search_calls"], ["toolCalls", "max_tool_calls"],
  ];
  for (const [estimateKey, rateKey] of limitPairs) {
    if (units(estimate[estimateKey]) > asSafeBigInt(rate[rateKey], rateKey)) {
      throw new Error(`Work estimate exceeds ${rateKey}.`);
    }
  }

  const quoted = calculateCreditsFromRate(rate, estimate);
  const maximumRateCredits = asSafeBigInt(rate.maximum_credits, "maximum credits");
  if (quoted > maximumRateCredits) throw new Error("Calculated quote exceeds the rate-card maximum.");
  const safetyBps = asSafeBigInt(config.quote_safety_multiplier_bps, "quote safety multiplier");
  const maximum = [ceilDiv(quoted * safetyBps, BigInt(10_000)), maximumRateCredits]
    .reduce((left, right) => left < right ? left : right);
  const estimatedCost = calculateMaximumProviderCostMicrousd(price, estimate);
  const providerBudget = ceilDiv(estimatedCost * safetyBps, BigInt(10_000));
  const rateCostCeiling = asSafeBigInt(rate.max_provider_cost_microusd, "provider cost ceiling");
  if (providerBudget > rateCostCeiling) throw new Error("Estimated provider cost exceeds the approved rate card.");

  const netRevenueSen = ceilDiv(
    quoted * asSafeBigInt(config.net_revenue_sen_per_1000_credits, "net credit revenue"),
    BigInt(1000),
  );
  const targetProviderSen = netRevenueSen * asSafeBigInt(config.provider_cost_target_bps, "provider cost target") / BigInt(10_000);
  const marginBudgetMicrousd = targetProviderSen * BigInt(1_000_000) /
    asSafeBigInt(config.budget_myr_sen_per_usd, "budget exchange rate");
  if (providerBudget > marginBudgetMicrousd) {
    throw new Error("The configured quote would violate the provider-cost margin floor.");
  }

  return {
    featureKey,
    featureRateCardId: String(rate.id),
    providerRouteId: String(route.id),
    provider: String(price.provider),
    model: String(price.model),
    quotedCredits: toSafeNumber(quoted, "quoted credits"),
    maximumCredits: toSafeNumber(maximum, "maximum credits"),
    estimatedProviderCostMicrousd: toSafeNumber(estimatedCost, "estimated provider cost"),
    providerBudgetMicrousd: toSafeNumber(providerBudget, "provider budget"),
    limits: {
      ...estimate,
      retries: toSafeNumber(asSafeBigInt(rate.max_retries, "retry limit"), "retry limit"),
      timeoutMs: toSafeNumber(asSafeBigInt(rate.timeout_ms, "timeout"), "timeout"),
    },
  };
}

export async function reserveMeteredWork(input: {
  userId: string;
  projectId: string | null;
  featureKey: string;
  estimate: TrustedWorkEstimate;
  jobKey: string;
  idempotencyKey: string;
}) {
  const quote = await quoteMeteredWork(input.featureKey, input.estimate);
  const admin = createBillingAdminClient();
  const { data, error } = await admin.rpc("aido_reserve_credits", {
    p_user_id: input.userId,
    p_project_id: input.projectId,
    p_feature_key: quote.featureKey,
    p_feature_rate_card_id: quote.featureRateCardId,
    p_provider_route_id: quote.providerRouteId,
    p_job_key: input.jobKey,
    p_idempotency_key: input.idempotencyKey,
    p_quoted_credits: quote.quotedCredits,
    p_maximum_credits: quote.maximumCredits,
    p_provider_budget_microusd: quote.providerBudgetMicrousd,
    p_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
  if (error) throw error;
  const reservation = Array.isArray(data) ? data[0] : data;
  if (!reservation?.reservation_id) throw new Error("Reservation returned no identifier.");
  return { quote, reservation };
}
