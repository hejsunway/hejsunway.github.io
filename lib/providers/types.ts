export type JsonObject = Record<string, unknown>;

export type ProviderId = "openai" | "deepseek" | "minimax";

export type ProviderMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ProviderFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: JsonObject;
  strict?: boolean;
};

export type ProviderRequest = {
  model: string;
  instructions: string;
  messages: ProviderMessage[];
  tools: ProviderFunctionTool[];
  maxOutputTokens: number;
  idempotencyKey: string;
  signal: AbortSignal;
};

export type ProviderUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  toolCalls: number;
  searches: number;
};

export type ProviderResult = {
  responseId: string | null;
  model: string;
  text: string;
  raw: JsonObject;
  usage: ProviderUsage;
  completed: boolean;
  failureCategory: string | null;
};

export type ProviderAdapter = {
  provider: ProviderId;
  execute(request: ProviderRequest): Promise<ProviderResult>;
};

export class ProviderProtocolError extends Error {
  readonly category: string;

  constructor(category: string, message: string) {
    super(message);
    this.name = "ProviderProtocolError";
    this.category = category;
  }
}
