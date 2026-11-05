import { randomUUID } from "node:crypto";
import type { ModelClient, ModelRequest, ModelResponse } from "42-agent";
import { OpenRouterModelClient } from "42-agent/provider";
import { parseModelProviderPriority } from "../scripts/model-provider-priority.mjs";

export interface PlatformModel {
  provider: "deepseek" | "openrouter";
  modelId: string;
  baseUrl: string;
  apiKey: string;
}
export interface ModelAttempt {
  id: string;
  provider: PlatformModel["provider"];
  modelId: string;
  status: "started" | "succeeded" | "failed" | "unknown";
  code?: string;
}
export class ModelsUnavailableError extends Error {
  readonly code = "models_unavailable";
  constructor() { super("当前 AI 服务暂不可用，本场进度已保留，请稍后重试。"); }
}
export class ModelOutcomeUnknownError extends Error {
  readonly code = "model_outcome_unknown";
  constructor() { super("模型请求结果未能确认，本场进度已保留，请稍后重试。"); }
}

/** Secrets are read only in the coordinator and sent over private worker IPC. */
export function platformModels(env: Record<string, string | undefined> = process.env): PlatformModel[] {
  const priority = parseModelProviderPriority(env.HUB_MODEL_PROVIDER_PRIORITY);
  const models: Record<PlatformModel["provider"], PlatformModel> = {
    openrouter: { provider: "openrouter", modelId: env.OPENROUTER_MODEL?.trim() || "openai/gpt-5.4", baseUrl: env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1", apiKey: env.OPENROUTER_API_KEY?.trim() || "" },
    deepseek: { provider: "deepseek", modelId: env.DEEPSEEK_MODEL?.trim() || "deepseek-flash", baseUrl: env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com", apiKey: env.DEEPSEEK_API_KEY?.trim() || "" },
  };
  return priority.map((provider) => models[provider]).filter((model) => {
    if (!model.apiKey || env[`${model.provider.toUpperCase()}_ENABLED`]?.trim().toLowerCase() === "false") return false;
    let url: URL;
    try { url = new URL(model.baseUrl); } catch { return false; }
    const localTest = env.NODE_ENV === "test" && !env.VERCEL && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((!localTest && url.protocol !== "https:") || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
    return true;
  });
}

function transport(model: PlatformModel, fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (init?.method === "POST" && typeof init.body === "string") {
      const body = JSON.parse(init.body);
      const headers = new Headers(init.headers);
      if (model.provider === "deepseek") headers.delete("x-openrouter-title");
      return fetcher(input, { ...init, headers, redirect: "error", body: JSON.stringify({ ...body, max_tokens: 2048, ...(model.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}) }) });
    }
    return fetcher(input, init);
  };
}

/** Reuses the core's canonical message/tool conversion without OpenRouter metadata calls. */
export class DeepSeekModelClient implements ModelClient {
  private readonly client: OpenRouterModelClient;
  constructor(model: PlatformModel, fetcher: typeof fetch = fetch) {
    this.client = new OpenRouterModelClient({ apiKey: model.apiKey, model: model.modelId, baseUrl: model.baseUrl, fetch: transport(model, fetcher) });
  }
  complete(request: ModelRequest) { return this.client.complete(request); }
}

/** Fallback happens before any tool executes. Never retry an ambiguous transport result. */
export class PriorityModelClient implements ModelClient {
  constructor(private readonly models: PlatformModel[], private readonly report: (attempt: ModelAttempt) => Promise<void> = async () => {}, private readonly fetcher: typeof fetch = fetch) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    for (const model of this.models) {
      request.signal?.throwIfAborted();
      const id = randomUUID();
      const attempt = { id, provider: model.provider, modelId: model.modelId };
      await this.report({ ...attempt, status: "started" });
      const client = model.provider === "deepseek" ? new DeepSeekModelClient(model, this.fetcher)
        : new OpenRouterModelClient({ apiKey: model.apiKey, model: model.modelId, baseUrl: model.baseUrl, fetch: transport(model, this.fetcher) });
      let result: ModelResponse;
      try { result = await client.complete(request); }
      catch (error) {
        if (request.signal?.aborted) throw error;
        // An explicit HTTP rejection is a confirmed failure. Network disconnects,
        // timeouts and invalid/truncated responses may have been billed already.
        const status = /^OpenRouter\s+(\d{3}):/.exec(error instanceof Error ? error.message : "")?.[1];
        const known = Boolean(status && [400, 401, 402, 403, 404, 408, 422, 429, 500, 502, 503, 504].includes(Number(status)));
        await this.report({ ...attempt, status: known ? "failed" : "unknown", code: status || "transport" });
        if (known) continue;
        throw new ModelOutcomeUnknownError();
      }
      // Hub turns require a tool action. A successful text-only HTTP response
      // cannot perform that task and is safe to fail over before tool execution.
      if (request.tools.length && !result.toolCalls?.length) {
        await this.report({ ...attempt, status: "failed", code: "missing_action" });
        continue;
      }
      await this.report({ ...attempt, status: "succeeded" });
      return result;
    }
    throw new ModelsUnavailableError();
  }
}
