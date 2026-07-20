import "server-only";

import { createOpenAICompatibleChatAdapter } from "@/lib/providers/adapters/openai-compatible-chat";
import { createOpenAIResponsesAdapter } from "@/lib/providers/adapters/openai-responses";
import { nonnegativeInteger } from "@/lib/providers/adapters/shared";
import type { JsonObject, ProviderAdapter, ProviderId } from "@/lib/providers/types";

const DEEPSEEK_CHAT_ENDPOINT = "https://api.deepseek.com/chat/completions";
const MINIMAX_CHAT_ENDPOINT = "https://api.minimax.io/v1/chat/completions";

function requiredSecret(name: "OPENAI_API_KEY" | "DEEPSEEK_API_KEY" | "MINIMAX_API_KEY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured on the server.`);
  return value;
}

function cachedFromDetails(usage: JsonObject): number {
  const details = usage.prompt_tokens_details
    && typeof usage.prompt_tokens_details === "object"
    && !Array.isArray(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details as JsonObject
    : {};
  return nonnegativeInteger(details.cached_tokens);
}

export function isProviderId(value: string): value is ProviderId {
  return value === "openai" || value === "deepseek" || value === "minimax";
}

export function resolveProviderAdapter(provider: string): ProviderAdapter {
  if (!isProviderId(provider)) {
    throw new Error(`Provider ${provider} is not approved by the server gateway.`);
  }
  switch (provider) {
    case "openai":
      return createOpenAIResponsesAdapter(requiredSecret("OPENAI_API_KEY"));
    case "deepseek":
      return createOpenAICompatibleChatAdapter({
        provider,
        endpoint: DEEPSEEK_CHAT_ENDPOINT,
        apiKey: requiredSecret("DEEPSEEK_API_KEY"),
        maxTokenField: "max_tokens",
        cachedTokens: (usage) => nonnegativeInteger(usage.prompt_cache_hit_tokens),
      });
    case "minimax":
      return createOpenAICompatibleChatAdapter({
        provider,
        endpoint: MINIMAX_CHAT_ENDPOINT,
        apiKey: requiredSecret("MINIMAX_API_KEY"),
        maxTokenField: "max_completion_tokens",
        cachedTokens: cachedFromDetails,
      });
  }
}
