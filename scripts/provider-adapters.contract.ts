import assert from "node:assert/strict";
import { createOpenAICompatibleChatAdapter } from "../lib/providers/adapters/openai-compatible-chat";
import { createOpenAIResponsesAdapter } from "../lib/providers/adapters/openai-responses";
import type { ProviderRequest } from "../lib/providers/types";

type CapturedRequest = { url: string; init: RequestInit };

const baseRequest: ProviderRequest = {
  model: "approved-model-version",
  instructions: "Return a verified result.",
  messages: [{ role: "user", content: "Analyse this assignment." }],
  tools: [],
  maxOutputTokens: 750,
  idempotencyKey: "provider-contract-idempotency",
  signal: new AbortController().signal,
};

async function captureFetch(payload: Record<string, unknown>, status = 200) {
  let captured: CapturedRequest | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    assert.ok(captured, "adapter did not issue a provider request");
    return captured;
  };
}

async function main() {
  const originalFetch = globalThis.fetch;
  try {
  const openAICapture = await captureFetch({
    id: "resp_contract_openai",
    status: "completed",
    model: "approved-model-version",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: "OpenAI result" }],
    }],
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
      output_tokens: 45,
    },
  });
  const openAI = await createOpenAIResponsesAdapter("test-key").execute(baseRequest);
  const openAIRequest = openAICapture();
  assert.equal(openAIRequest.url, "https://api.openai.com/v1/responses");
  assert.equal(new Headers(openAIRequest.init.headers).get("Idempotency-Key"), baseRequest.idempotencyKey);
  const openAIBody = JSON.parse(String(openAIRequest.init.body));
  assert.deepEqual(openAIBody.input, baseRequest.messages);
  assert.equal(openAIBody.max_output_tokens, 750);
  assert.equal(openAIBody.store, false);
  assert.ok(!("tools" in openAIBody), "empty OpenAI tools should be omitted");
  assert.equal(openAI.text, "OpenAI result");
  assert.deepEqual(openAI.usage, {
    inputTokens: 120,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 30,
    outputTokens: 45,
    toolCalls: 0,
    searches: 0,
  });

  const deepSeekCapture = await captureFetch({
    id: "chatcmpl_contract_deepseek",
    model: "approved-model-version",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "save_result", arguments: "{}" } }],
      },
    }],
    usage: {
      prompt_tokens: 210,
      prompt_cache_hit_tokens: 80,
      completion_tokens: 55,
    },
  });
  const deepSeek = await createOpenAICompatibleChatAdapter({
    provider: "deepseek",
    endpoint: "https://api.deepseek.com/chat/completions",
    apiKey: "test-key",
    maxTokenField: "max_tokens",
    inputTokenDetails: (usage) => ({
      cachedInputTokens: Number(usage.prompt_cache_hit_tokens ?? 0),
      cacheWriteInputTokens: 0,
    }),
  }).execute({
    ...baseRequest,
    tools: [{
      type: "function",
      name: "save_result",
      description: "Persist a validated result.",
      parameters: { type: "object", properties: {} },
      strict: true,
    }],
  });
  const deepSeekRequest = deepSeekCapture();
  const deepSeekBody = JSON.parse(String(deepSeekRequest.init.body));
  assert.equal(deepSeekRequest.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(deepSeekBody.messages[0], { role: "system", content: baseRequest.instructions });
  assert.equal(deepSeekBody.max_tokens, 750);
  assert.equal(deepSeekBody.tools[0].function.name, "save_result");
  assert.equal(deepSeekBody.tools[0].function.strict, true);
  assert.deepEqual(deepSeek.usage, {
    inputTokens: 210,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 0,
    outputTokens: 55,
    toolCalls: 1,
    searches: 0,
  });

  const miniMaxCapture = await captureFetch({
    id: "chatcmpl_contract_minimax",
    model: "approved-model-version",
    choices: [{ finish_reason: "stop", message: { content: "MiniMax result" } }],
    usage: {
      prompt_tokens: 95,
      prompt_tokens_details: { cached_tokens: 15, cache_write_tokens: 10 },
      completion_tokens: 30,
    },
  });
  const miniMax = await createOpenAICompatibleChatAdapter({
    provider: "minimax",
    endpoint: "https://api.minimax.io/v1/chat/completions",
    apiKey: "test-key",
    maxTokenField: "max_completion_tokens",
    inputTokenDetails: (usage) => {
      const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
      return {
        cachedInputTokens: Number(details?.cached_tokens ?? 0),
        cacheWriteInputTokens: Number(details?.cache_write_tokens ?? 0),
      };
    },
  }).execute(baseRequest);
  const miniMaxBody = JSON.parse(String(miniMaxCapture().init.body));
  assert.equal(miniMaxBody.max_completion_tokens, 750);
  assert.ok(!("tools" in miniMaxBody), "empty chat-completion tools should be omitted");
  assert.equal(miniMax.text, "MiniMax result");
  assert.equal(miniMax.usage.cachedInputTokens, 15);
  assert.equal(miniMax.usage.cacheWriteInputTokens, 10);

  const incompleteCapture = await captureFetch({
    id: "resp_contract_incomplete",
    status: "incomplete",
    model: "approved-model-version",
    output: [],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const incomplete = await createOpenAIResponsesAdapter("test-key").execute(baseRequest);
  incompleteCapture();
  assert.equal(incomplete.completed, false);
  assert.equal(incomplete.failureCategory, "provider_incomplete_response");

  console.log("Provider adapter contract tests passed (OpenAI, DeepSeek, MiniMax, incomplete response).");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
