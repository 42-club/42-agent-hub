import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRequest } from "42-agent";
import { platformModels, PriorityModelClient, ModelsUnavailableError, ModelOutcomeUnknownError, type ModelAttempt } from "../server/platform-models";
import { parseModelProviderPriority } from "../scripts/model-provider-priority.mjs";

const credentials = { NODE_ENV: "test", DEEPSEEK_API_KEY: "deepseek-secret", OPENROUTER_API_KEY: "router-secret" };
// Explicit reverse order keeps the DeepSeek adapter/fallback regressions covered.
const models = platformModels({ ...credentials, HUB_MODEL_PROVIDER_PRIORITY: "deepseek,openrouter" });
const request: ModelRequest = { systemPrompt: "你是陈序", messages: [{ role: "user", content: "只可见的本轮任务" }], tools: [{ name: "vote", description: "投票", inputSchema: { type: "object", properties: { targetId: { type: "string" } } } }] };
const success = () => Response.json({ choices: [{ message: { tool_calls: [{ id: "call", type: "function", function: { name: "vote", arguments: '{"targetId":"seat-2"}' } }] } }] });

test("platform model credentials are server-owned and default priority is OpenRouter then DeepSeek", () => {
  assert.deepEqual(platformModels(credentials).map((model) => model.provider), ["openrouter", "deepseek"]);
  assert.deepEqual(platformModels({}), []);
  assert.deepEqual(platformModels({ OPENROUTER_API_KEY: "key" }).map((model) => model.provider), ["openrouter"]);
  assert.deepEqual(platformModels({ DEEPSEEK_API_KEY: "key" }).map((model) => model.provider), ["deepseek"]);
  assert.deepEqual(platformModels({ DEEPSEEK_API_KEY: "key", DEEPSEEK_BASE_URL: "http://evil.example/api" }), []);
  assert.deepEqual(platformModels({ DEEPSEEK_API_KEY: "key", DEEPSEEK_BASE_URL: "invalid", OPENROUTER_API_KEY: "key" }).map((model) => model.provider), ["openrouter"]);
  assert.deepEqual(platformModels({ DEEPSEEK_API_KEY: "key", DEEPSEEK_ENABLED: "false", OPENROUTER_API_KEY: "key" }).map((model) => model.provider), ["openrouter"]);
});

test("provider priority accepts case, whitespace and duplicates, defaults when empty, and rejects unknown names", () => {
  for (const value of [undefined, "", "  ", ", ,,"]) assert.deepEqual(parseModelProviderPriority(value), ["openrouter", "deepseek"]);
  assert.deepEqual(parseModelProviderPriority(" DeepSeek , OPENROUTER , deepseek,,OpenRouter,"), ["deepseek", "openrouter"]);
  assert.deepEqual(parseModelProviderPriority("OPENROUTER"), ["openrouter"]);
  assert.deepEqual(parseModelProviderPriority("deepseek"), ["deepseek"]);
  for (const value of ["openroutre,deepseek", "private-config-value", "openrouter;deepseek", "openrouter，deepseek"]) {
    assert.throws(() => parseModelProviderPriority(value), (error: unknown) => error instanceof Error && error.message.includes("HUB_MODEL_PROVIDER_PRIORITY") && !error.message.includes(value));
    assert.throws(() => platformModels({ HUB_MODEL_PROVIDER_PRIORITY: value }), /HUB_MODEL_PROVIDER_PRIORITY/, "invalid priority fails even without model credentials");
  }
});

test("actual model calls follow default and configured order, restarting at the first provider every inference", async () => {
  for (const priority of [undefined, " DEEPSEEK , OpenRouter "]) {
    const ordered = platformModels({ ...credentials, HUB_MODEL_PROVIDER_PRIORITY: priority });
    const attempted: string[] = [], reports: ModelAttempt[] = [];
    const client = new PriorityModelClient(ordered, async (attempt) => { reports.push(attempt); }, async (url) => {
      attempted.push(String(url));
      return attempted.length % 2 ? new Response("unavailable", { status: 503 }) : success();
    });
    await client.complete(request); await client.complete(request);
    const urls = ordered.map((model) => `${model.baseUrl}/chat/completions`);
    assert.deepEqual(attempted, [...urls, ...urls]);
    assert.deepEqual(reports.filter((attempt) => attempt.status === "started").map((attempt) => attempt.provider), [...ordered, ...ordered].map((model) => model.provider));
    assert.equal(reports.filter((attempt) => attempt.status === "succeeded").length, 2);
  }
});

test("an explicit provider list is complete and unavailable entries never reintroduce excluded providers", async () => {
  const onlyDeepSeek = platformModels({ ...credentials, HUB_MODEL_PROVIDER_PRIORITY: "DEEPSEEK" });
  assert.deepEqual(onlyDeepSeek.map((model) => model.provider), ["deepseek"]);
  assert.deepEqual(platformModels({ ...credentials, HUB_MODEL_PROVIDER_PRIORITY: "DEEPSEEK", DEEPSEEK_ENABLED: "false" }), []);
  assert.deepEqual(platformModels({ ...credentials, HUB_MODEL_PROVIDER_PRIORITY: "DEEPSEEK", DEEPSEEK_API_KEY: "" }), []);
  assert.deepEqual(platformModels({ ...credentials, HUB_MODEL_PROVIDER_PRIORITY: "DEEPSEEK", DEEPSEEK_BASE_URL: "invalid" }), []);
  let calls = 0;
  const client = new PriorityModelClient(onlyDeepSeek, undefined, async (url) => { calls++; assert.match(String(url), /^https:\/\/api.deepseek.com\//); return new Response("unavailable", { status: 503 }); });
  await assert.rejects(client.complete(request), ModelsUnavailableError);
  assert.equal(calls, 1, "OpenRouter must not be appended after the selected provider fails");
});

test("configured DeepSeek-first inference preserves persona/context and disables thinking", async () => {
  const calls: string[] = [], attempts: ModelAttempt[] = [];
  const client = new PriorityModelClient(models, async (attempt) => { attempts.push(attempt); }, async (url, init) => {
    calls.push(String(url));
    const payload = JSON.parse(String(init!.body));
    assert.equal(new Headers(init!.headers).get("authorization"), "Bearer deepseek-secret");
    assert.equal(new Headers(init!.headers).has("x-openrouter-title"), false);
    assert.deepEqual(payload.thinking, { type: "disabled" });
    assert.equal(payload.messages[0].content, request.systemPrompt);
    assert.equal(payload.messages[1].content, request.messages[0].content);
    assert.equal(payload.max_tokens, 2048);
    return success();
  });
  await client.complete(request); await client.complete(request);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url === "https://api.deepseek.com/chat/completions"));
  assert.deepEqual(attempts.map((a) => a.status), ["started", "succeeded", "started", "succeeded"]);
  assert.equal(new Set(attempts.map((a) => a.id)).size, 2);
});

test("explicit provider failures fall through in order, with unchanged tools and conversation", async () => {
  for (const status of [400, 401, 402, 403, 404, 408, 422, 429, 500, 502, 503, 504]) {
    const calls: { url: string; body: Record<string, unknown> }[] = [], attempts: ModelAttempt[] = [];
    const client = new PriorityModelClient(models, async (attempt) => { attempts.push(attempt); }, async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init!.body)) });
      return calls.length === 1 ? new Response("private-provider-error", { status }) : success();
    });
    assert.equal((await client.complete(request)).toolCalls?.[0].name, "vote");
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /^https:\/\/openrouter.ai/);
    assert.deepEqual(calls[0].body.messages, calls[1].body.messages);
    assert.deepEqual(calls[0].body.tools, calls[1].body.tools);
    assert.deepEqual(attempts.map((a) => a.status), ["started", "failed", "started", "succeeded"]);
    assert.ok(!JSON.stringify(attempts).includes("private-provider-error"));
  }
});

test("all unavailable models produce a safe actionable error without extra retries", async () => {
  let count = 0;
  const client = new PriorityModelClient(models, undefined, async () => { count++; return new Response("sensitive", { status: 503 }); });
  await assert.rejects(client.complete(request), ModelsUnavailableError);
  assert.equal(count, 2);
  await assert.rejects(new PriorityModelClient([]).complete(request), ModelsUnavailableError);
});

test("a text-only response cannot impersonate an action or block the fallback model", async () => {
  let count = 0;
  const attempts: ModelAttempt[] = [];
  const client = new PriorityModelClient(models, async (attempt) => { attempts.push(attempt); }, async () => {
    count++; return count === 1 ? Response.json({ choices: [{ message: { content: "I voted without calling a tool" } }] }) : success();
  });
  assert.equal((await client.complete(request)).toolCalls?.[0].name, "vote");
  assert.equal(count, 2);
  assert.equal(attempts[1].code, "missing_action");
});

test("unknown outcomes, cancellation and failed durable attempt writes never dispatch another model", async () => {
  let count = 0;
  const attempts: ModelAttempt[] = [];
  const client = new PriorityModelClient(models, async (attempt) => { attempts.push(attempt); }, async () => { count++; throw new TypeError("fetch failed private-key"); });
  await assert.rejects(client.complete(request), ModelOutcomeUnknownError);
  assert.equal(count, 1); assert.equal(attempts.at(-1)?.status, "unknown");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.complete({ ...request, signal: controller.signal }), { name: "AbortError" });
  assert.equal(count, 1);
  const storage = new PriorityModelClient(models, async () => { throw new Error("storage"); }, async () => { count++; return success(); });
  await assert.rejects(storage.complete(request), /storage/);
  assert.equal(count, 1);
});
