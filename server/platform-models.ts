import { randomUUID } from "node:crypto";
import type { ModelClient, ModelRequest, ModelResponse } from "42-agent";
import { OpenRouterModelClient } from "42-agent/provider";
import { modelRetryPolicy } from "../scripts/model-retry-config.mjs";
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
  decisionId?: string;
  attemptNumber?: number;
  retryAt?: string;
  next?: "retry" | "fallback";
  recovery?: "retrying" | "fallback";
  requestId?: string;
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

export type ModelRetryPolicy = ReturnType<typeof modelRetryPolicy>;
type FailureKind = "authentication" | "credits" | "model_unavailable" | "rate_limit" | "server" | "timeout" | "transport" | "invalid_response" | "invalid_request" | "context_length" | "policy" | "model_incompatible";

export class ModelServiceError extends Error {
  constructor(readonly kind: FailureKind, readonly retryable: boolean, readonly canFallback: boolean, readonly uncertain = false,
    readonly status?: number, readonly retryAfterMs?: number, readonly requestId?: string) {
    super(`Model service failure: ${kind}`);
  }
}
export class ModelRequestRejectedError extends Error {
  readonly code = "invalid_request";
  constructor() { super("模型服务拒绝了当前请求，请检查请求参数或内容。"); }
}
export class ModelRetryBudgetError extends ModelsUnavailableError {}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function providerFailure(status: number, error: any, retryAfterMs?: number, requestId?: string): ModelServiceError {
  const type = String(error?.metadata?.error_type ?? error?.error_type ?? error?.type ?? "");
  if (["content_policy_violation", "refusal"].includes(type)) return new ModelServiceError("policy", false, false, false, status, undefined, requestId);
  if (["context_length_exceeded", "max_tokens_exceeded", "token_limit_exceeded", "string_too_long"].includes(type)) return new ModelServiceError("context_length", false, false, false, status, undefined, requestId);
  if (["unsupported_parameter", "unsupported_model"].includes(type)) return new ModelServiceError("model_incompatible", false, true, false, status, undefined, requestId);
  if (["invalid_request", "invalid_prompt", "unprocessable", "payload_too_large"].includes(type)) return new ModelServiceError("invalid_request", false, false, false, status, undefined, requestId);
  if (["authentication", "permission_denied"].includes(type)) return new ModelServiceError("authentication", false, true, false, status, undefined, requestId);
  if (type === "payment_required") return new ModelServiceError("credits", false, true, false, status, undefined, requestId);
  if (type === "not_found") return new ModelServiceError("model_unavailable", false, true, false, status, undefined, requestId);
  if (type === "rate_limit_exceeded" || status === 429) return new ModelServiceError("rate_limit", true, true, false, status, retryAfterMs, requestId);
  if (type === "timeout" || status === 408 || status === 504) return new ModelServiceError("timeout", true, true, true, status, retryAfterMs, requestId);
  if (["provider_overloaded", "provider_unavailable", "server"].includes(type) || status >= 500) return new ModelServiceError("server", true, true, false, status, retryAfterMs, requestId);
  if (status === 401 || status === 403) return new ModelServiceError("authentication", false, true, false, status, undefined, requestId);
  if (status === 402) return new ModelServiceError("credits", false, true, false, status, undefined, requestId);
  if (status === 404) return new ModelServiceError("model_unavailable", false, true, false, status, undefined, requestId);
  return new ModelServiceError("invalid_request", false, false, false, status, undefined, requestId);
}

function transport(model: PlatformModel, fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (init?.method !== "POST" || typeof init.body !== "string") return fetcher(input, init);
    const body = JSON.parse(init.body);
    const headers = new Headers(init.headers);
    if (model.provider === "deepseek") headers.delete("x-openrouter-title");
    const response = await fetcher(input, { ...init, headers, redirect: "error", body: JSON.stringify({ ...body, max_tokens: 2048, ...(model.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}) }) });
    const rawId = response.headers.get("x-request-id");
    const requestId = rawId && /^[a-zA-Z0-9_-]{1,128}$/.test(rawId) ? rawId : undefined;
    const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
    let payload: any;
    try { payload = await response.json(); }
    catch {
      if (!response.ok) throw providerFailure(response.status, undefined, retryAfter, requestId);
      throw new ModelServiceError("invalid_response", true, true, true, response.status, undefined, requestId);
    }
    if (!response.ok) throw providerFailure(response.status, payload?.error, retryAfter, requestId);
    const choice = payload?.choices?.[0];
    const error = payload?.error ?? choice?.error;
    if (error || choice?.finish_reason === "error") {
      const code = Number(error?.code);
      throw providerFailure(Number.isInteger(code) && code >= 400 && code < 600 ? code : 502, error, retryAfter, requestId);
    }
    if (choice?.finish_reason === "content_filter" || choice?.message?.refusal) throw new ModelServiceError("policy", false, false);
    if (choice?.finish_reason === "length") throw new ModelServiceError("context_length", false, false);
    // The core remains responsible for canonical message/tool conversion.
    return Response.json(payload);
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

export async function waitForModelRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

interface RetryOptions {
  policy?: ModelRetryPolicy;
  deadlineAt?: number;
  now?: () => number;
  wait?: typeof waitForModelRetry;
  random?: () => number;
}

/** One retry owner for the whole turn: each decision shares this client's deadline. */
export class PriorityModelClient implements ModelClient {
  private readonly policy: ModelRetryPolicy;
  private readonly deadlineAt: number;
  private readonly now: () => number;
  private readonly wait: typeof waitForModelRetry;
  private readonly random: () => number;
  private readonly cooldowns = new Map<string, number>();
  constructor(private readonly models: PlatformModel[], private readonly report: (attempt: ModelAttempt) => Promise<void> = async () => {}, private readonly fetcher: typeof fetch = fetch, options: RetryOptions = {}) {
    this.policy = options.policy ?? modelRetryPolicy();
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? waitForModelRetry;
    this.random = options.random ?? Math.random;
    this.deadlineAt = Math.min(options.deadlineAt ?? Infinity, this.now() + this.policy.budgetMs);
  }
  private remaining() { return this.deadlineAt - this.now(); }
  private async invoke(model: PlatformModel, request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new ModelServiceError("timeout", true, true, true)), Math.min(this.policy.requestTimeoutMs, this.remaining()));
    let abort = () => {};
    try {
      const client = model.provider === "deepseek" ? new DeepSeekModelClient(model, this.fetcher)
        : new OpenRouterModelClient({ apiKey: model.apiKey, model: model.modelId, baseUrl: model.baseUrl, fetch: transport(model, this.fetcher) });
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return await Promise.race([client.complete({ ...request, signal }), cancelled]);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    const decisionId = randomUUID();
    for (const [providerIndex, model] of this.models.entries()) {
      const key = `${model.provider}:${model.baseUrl}:${model.modelId}`;
      if ((this.cooldowns.get(key) ?? 0) > this.now()) continue;
      for (let attemptNumber = 1; attemptNumber <= this.policy.maxAttempts; attemptNumber++) {
        request.signal?.throwIfAborted();
        if (this.remaining() <= 0) throw new ModelRetryBudgetError();
        const recovery = providerIndex > 0 ? "fallback" as const : attemptNumber > 1 ? "retrying" as const : undefined;
        const attempt = { id: randomUUID(), decisionId, provider: model.provider, modelId: model.modelId, attemptNumber, recovery };
        // Parent acknowledgement checks the lease, generation, phase and pending seat.
        // Storage failures are outside the provider catch and must never trigger I/O retries.
        await this.report({ ...attempt, status: "started" });
        request.signal?.throwIfAborted();
        if (this.remaining() <= 0) throw new ModelRetryBudgetError();
        let result: ModelResponse;
        let failure: ModelServiceError | undefined;
        try { result = await this.invoke(model, request); }
        catch (error) {
          if (request.signal?.aborted) throw error;
          failure = error instanceof ModelServiceError ? error : new ModelServiceError(error instanceof SyntaxError ? "invalid_response" : "transport", true, true, true);
        }
        if (!failure) {
          if (request.tools.length && !result!.toolCalls?.length) {
            await this.report({ ...attempt, status: "failed", code: "missing_action", next: providerIndex + 1 < this.models.length ? "fallback" : undefined });
            break;
          }
          await this.report({ ...attempt, status: "succeeded" });
          return result!;
        }
        if (failure.retryAfterMs) this.cooldowns.set(key, this.now() + failure.retryAfterMs);
        const backoff = Math.min(10000, this.policy.baseDelayMs * 2 ** (attemptNumber - 1) * (0.8 + this.random() * 0.4));
        const delayMs = Math.ceil(Math.max(backoff, failure.retryAfterMs ?? 0));
        const retry = failure.retryable && attemptNumber < this.policy.maxAttempts && delayMs < this.remaining();
        const next = retry ? "retry" as const : failure.canFallback && providerIndex + 1 < this.models.length ? "fallback" as const : undefined;
        await this.report({ ...attempt, status: failure.uncertain ? "unknown" : "failed", code: failure.kind,
          requestId: failure.requestId, next, ...(retry ? { retryAt: new Date(this.now() + delayMs).toISOString() } : {}) });
        if (!failure.canFallback) throw new ModelRequestRejectedError();
        if (!retry) break;
        if (delayMs >= this.remaining()) break;
        await this.wait(delayMs, request.signal);
      }
    }
    throw new ModelsUnavailableError();
  }
}
