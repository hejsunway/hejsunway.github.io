import type { JsonObject } from "../types";
import { ProviderProtocolError } from "../types";

export function providerFailureCategory(status: number): string {
  if (status === 408 || status === 504) return "provider_timeout";
  if (status === 429) return "provider_rate_limit";
  if (status >= 500) return "provider_unavailable";
  return "provider_rejected_request";
}

export async function parseProviderJson(response: Response): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ProviderProtocolError(
      "provider_invalid_response",
      "The provider returned a response that was not valid JSON.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError(
      "provider_invalid_response",
      "The provider returned an invalid response envelope.",
    );
  }
  return value as JsonObject;
}

export function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
