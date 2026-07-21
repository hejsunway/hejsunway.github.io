import type {
  JsonObject,
  ProviderAdapter,
  ProviderFunctionTool,
  ProviderId,
  ProviderRequest,
} from "../types";
import {
  nonnegativeInteger,
  nullableString,
  parseProviderJson,
  providerFailureCategory,
} from "./shared";

type ChatAdapterOptions = {
  provider: Exclude<ProviderId, "openai">;
  endpoint: string;
  apiKey: string;
  maxTokenField: "max_tokens" | "max_completion_tokens";
  inputTokenDetails(usage: JsonObject): {
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
  };
};

function chatTool(tool: ProviderFunctionTool): JsonObject {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
  };
}

function firstChoice(payload: JsonObject): JsonObject {
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) return {};
  const choice = payload.choices[0];
  return choice && typeof choice === "object" && !Array.isArray(choice)
    ? choice as JsonObject
    : {};
}

function choiceMessage(choice: JsonObject): JsonObject {
  return choice.message && typeof choice.message === "object" && !Array.isArray(choice.message)
    ? choice.message as JsonObject
    : {};
}

export function createOpenAICompatibleChatAdapter(options: ChatAdapterOptions): ProviderAdapter {
  return {
    provider: options.provider,
    async execute(request: ProviderRequest) {
      const response = await fetch(options.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          model: request.model,
          messages: [
            ...(request.instructions ? [{ role: "system", content: request.instructions }] : []),
            ...request.messages,
          ],
          ...(request.tools.length ? { tools: request.tools.map(chatTool) } : {}),
          [options.maxTokenField]: request.maxOutputTokens,
          stream: false,
        }),
        signal: request.signal,
      });
      const payload = await parseProviderJson(response);
      const usage = payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)
        ? payload.usage as JsonObject
        : {};
      const choice = firstChoice(payload);
      const message = choiceMessage(choice);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
      const finishReason = nullableString(choice.finish_reason);
      const completed = response.ok && (finishReason === "stop" || finishReason === "tool_calls");
      const inputTokenDetails = options.inputTokenDetails(usage);
      return {
        responseId: nullableString(payload.id),
        model: nullableString(payload.model) ?? request.model,
        text: typeof message.content === "string" ? message.content : "",
        raw: payload,
        usage: {
          inputTokens: nonnegativeInteger(usage.prompt_tokens),
          cachedInputTokens: nonnegativeInteger(inputTokenDetails.cachedInputTokens),
          cacheWriteInputTokens: nonnegativeInteger(inputTokenDetails.cacheWriteInputTokens),
          outputTokens: nonnegativeInteger(usage.completion_tokens),
          toolCalls,
          searches: 0,
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
