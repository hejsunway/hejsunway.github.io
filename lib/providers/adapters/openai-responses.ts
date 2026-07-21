import type {
  JsonObject,
  ProviderAdapter,
  ProviderFunctionTool,
  ProviderRequest,
} from "../types";
import {
  nonnegativeInteger,
  nullableString,
  parseProviderJson,
  providerFailureCategory,
} from "./shared";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

function outputText(payload: JsonObject): string {
  const parts: string[] = [];
  if (!Array.isArray(payload.output)) return "";
  for (const item of payload.output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const output = item as JsonObject;
    if (output.type !== "message" || !Array.isArray(output.content)) continue;
    for (const part of output.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const content = part as JsonObject;
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n");
}

function toolUsage(payload: JsonObject): { toolCalls: number; searches: number } {
  let toolCalls = 0;
  let searches = 0;
  if (!Array.isArray(payload.output)) return { toolCalls, searches };
  for (const item of payload.output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const type = (item as JsonObject).type;
    if (type === "web_search_call") searches += 1;
    if (typeof type === "string" && type.endsWith("_call")) toolCalls += 1;
  }
  return { toolCalls, searches };
}

function responseTool(tool: ProviderFunctionTool): JsonObject {
  return {
    type: "function",
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  };
}

export function createOpenAIResponsesAdapter(apiKey: string): ProviderAdapter {
  return {
    provider: "openai",
    async execute(request: ProviderRequest) {
      const response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          model: request.model,
          instructions: request.instructions,
          input: request.messages,
          ...(request.tools.length ? { tools: request.tools.map(responseTool) } : {}),
          max_output_tokens: request.maxOutputTokens,
          store: false,
        }),
        signal: request.signal,
      });
      const payload = await parseProviderJson(response);
      const usage = payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)
        ? payload.usage as JsonObject
        : {};
      const inputDetails = usage.input_tokens_details
        && typeof usage.input_tokens_details === "object"
        && !Array.isArray(usage.input_tokens_details)
        ? usage.input_tokens_details as JsonObject
        : {};
      const counts = toolUsage(payload);
      const completed = response.ok && payload.status === "completed";
      return {
        responseId: nullableString(payload.id),
        model: nullableString(payload.model) ?? request.model,
        text: outputText(payload),
        raw: payload,
        usage: {
          inputTokens: nonnegativeInteger(usage.input_tokens),
          cachedInputTokens: nonnegativeInteger(inputDetails.cached_tokens),
          cacheWriteInputTokens: nonnegativeInteger(inputDetails.cache_write_tokens),
          outputTokens: nonnegativeInteger(usage.output_tokens),
          toolCalls: counts.toolCalls,
          searches: counts.searches,
        },
        completed,
        failureCategory: completed
          ? null
          : response.ok
            ? "provider_incomplete_response"
            : providerFailureCategory(response.status),
      };
    },
  };
}
