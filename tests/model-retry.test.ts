import { test } from "node:test";
import assert from "node:assert/strict";
import { modelRetryPolicy } from "../scripts/model-retry-config.mjs";
import { PriorityModelClient, ModelRetryBudgetError, ModelRequestRejectedError, ModelsUnavailableError, retryAfterMilliseconds, waitForModelRetry, type PlatformModel, type ModelAttempt } from "../server/platform-models";
import type { ModelRequest } from "42-agent";
import { publicModelRecovery } from "../server/model-recovery";
import { createGame, getPendingParticipantIds } from "../src/domain/engine";
import { DEFAULT_OPTIONS } from "../src/domain/types";
import type { RoomRecord } from "../server/store";

const models: PlatformModel[] = ["openrouter", "deepseek"].map((provider) => ({ provider: provider as PlatformModel["provider"], modelId: provider, baseUrl: `https://${provider}.example`, apiKey: "private-key" }));
const request: ModelRequest = { systemPrompt: "同一个人物", messages: [{ role: "user", content: "当前决策" }], tools: [{ name: "vote", description: "投票", inputSchema: { type: "object", properties: {} } }] };
const policy = { maxAttempts: 2, baseDelayMs: 10, requestTimeoutMs: 1000, budgetMs: 10000 };
const success = () => Response.json({ choices: [{ message: { tool_calls: [{ id: "call", type: "function", function: { name: "vote", arguments: "{}" } }] } }] });

test("retry defaults and numeric limits are validated without echoing configuration values", () => {
  assert.deepEqual(modelRetryPolicy({}), { maxAttempts: 2, baseDelayMs: 1000, requestTimeoutMs: 25000, budgetMs: 120000 });
  assert.equal(modelRetryPolicy({ HUB_MODEL_MAX_ATTEMPTS: "3" }).maxAttempts, 3);
  for (const [name, value] of [["HUB_MODEL_MAX_ATTEMPTS", "0"], ["HUB_MODEL_MAX_ATTEMPTS", "6"], ["HUB_MODEL_RETRY_BASE_DELAY_MS", "-1"], ["HUB_MODEL_REQUEST_TIMEOUT_MS", "Infinity"], ["HUB_MODEL_RETRY_BUDGET_MS", "private-config"]]) assert.throws(() => modelRetryPolicy({ [name]: value }), new RegExp(name));
});

test("transient failures retry the same provider before fallback, with durable attempts and jitter", async () => {
  for (const [failures, expected] of [[1, ["openrouter", "openrouter"]], [2, ["openrouter", "openrouter", "deepseek"]]] as const) {
    const calls: string[] = [], records: ModelAttempt[] = [], waits: number[] = [];
    let clock = 1000;
    const client = new PriorityModelClient(models, async (attempt) => { records.push(attempt); }, async (url, init) => {
      assert.equal(records.filter((a) => a.status === "started").length, calls.length + 1, "write acknowledgement precedes every request");
      calls.push(String(url).includes("openrouter") ? "openrouter" : "deepseek");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.messages[0].content, request.systemPrompt);
      return calls.length <= failures ? new Response("private-upstream-diagnostics", { status: 503 }) : success();
    }, { policy, now: () => clock, random: () => 0.5, wait: async (ms) => { waits.push(ms); clock += ms; } });
    await client.complete(request);
    assert.deepEqual(calls, expected); assert.deepEqual(waits, [10]);
    assert.equal(new Set(records.map((a) => a.decisionId)).size, 1);
    assert.equal(new Set(records.filter((a) => a.status === "started").map((a) => a.id)).size, calls.length);
    assert.doesNotMatch(JSON.stringify(records), /private-upstream|private-key/);
  }
});

test("all transient failures are bounded across providers", async () => {
  let calls = 0;
  const client = new PriorityModelClient(models, undefined, async () => { calls++; return new Response("busy", { status: 500 }); }, { policy, wait: async () => {} });
  await assert.rejects(client.complete(request), ModelsUnavailableError);
  assert.equal(calls, 4, "two total attempts per provider, not unlimited retries");
});

test("HTTP 200 error bodies and choice errors use structured categories; auth skips retries", async () => {
  for (const envelope of [{ error: { code: 429, metadata: { error_type: "rate_limit_exceeded" } } }, { choices: [{ finish_reason: "error", error: { code: 503, metadata: { error_type: "provider_overloaded" } } }] }]) {
    let calls = 0;
    const client = new PriorityModelClient(models, undefined, async () => ++calls === 1 ? Response.json(envelope) : success(), { policy, wait: async () => {} });
    await client.complete(request); assert.equal(calls, 2);
  }
  for (const status of [401, 402, 403, 404]) {
    const calls: string[] = [];
    const client = new PriorityModelClient(models, undefined, async (url) => { calls.push(String(url)); return calls.length === 1 ? new Response("rejected", { status }) : success(); }, { policy });
    await client.complete(request); assert.equal(calls.length, 2); assert.match(calls[1], /deepseek/);
  }
});

test("request, context and policy errors do not repeat or use fallback to bypass a rejection", async () => {
  for (const body of [{ error: { code: 400 } }, { error: { metadata: { error_type: "context_length_exceeded" } } }, { error: { metadata: { error_type: "invalid_request" } } }, { error: { code: 403, metadata: { error_type: "refusal" } } }, { choices: [{ finish_reason: "content_filter", message: { refusal: "no" } }] }]) {
    let calls = 0;
    const client = new PriorityModelClient(models, undefined, async () => { calls++; return Response.json(body); }, { policy });
    await assert.rejects(client.complete(request), ModelRequestRejectedError); assert.equal(calls, 1);
  }
});

test("Retry-After supports seconds and dates and is never shortened by jitter", async () => {
  assert.equal(retryAfterMilliseconds("2.5", 0), 2500);
  assert.equal(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:05 GMT", 1000), 4000);
  assert.equal(retryAfterMilliseconds("not-a-date"), undefined);
  const waits: number[] = []; let calls = 0, clock = 1000;
  const client = new PriorityModelClient(models, undefined, async () => ++calls === 1 ? new Response("limited", { status: 429, headers: { "Retry-After": "3" } }) : success(), { policy, now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } });
  await client.complete(request); assert.deepEqual(waits, [3000]);
});

test("long provider cooldown falls back within budget and remains respected by later decisions", async () => {
  const calls: string[] = [];
  const client = new PriorityModelClient(models, undefined, async (url) => { calls.push(String(url)); return String(url).includes("openrouter") ? new Response("limited", { status: 429, headers: { "Retry-After": "60" } }) : success(); }, { policy, now: () => 1000, wait: async () => { assert.fail("cannot wait beyond budget"); } });
  await client.complete(request); await client.complete(request);
  assert.equal(calls.length, 3); assert.match(calls[0], /openrouter/); assert.ok(calls.slice(1).every((url) => url.includes("deepseek")));
});

test("budget is shared by all decisions and also includes backoff and attempt persistence", async () => {
  let clock = 1000, calls = 0;
  const client = new PriorityModelClient(models, undefined, async () => { calls++; clock += 60; return success(); }, { policy: { ...policy, budgetMs: 100 }, now: () => clock });
  await client.complete(request); await client.complete(request);
  await assert.rejects(client.complete(request), ModelRetryBudgetError); assert.equal(calls, 2);
  calls = 0; clock = 1000;
  const storage = new PriorityModelClient(models, async () => { clock += 101; }, async () => { calls++; return success(); }, { policy: { ...policy, budgetMs: 100 }, now: () => clock });
  await assert.rejects(storage.complete(request), ModelRetryBudgetError); assert.equal(calls, 0);
});

test("timeouts cancel the old local request before retry; late responses cannot win", async () => {
  const signals: AbortSignal[] = []; const records: ModelAttempt[] = []; let release!: (response: Response) => void;
  const client = new PriorityModelClient(models, async (attempt) => { records.push(attempt); }, async (_url, init) => {
    signals.push(init!.signal as AbortSignal);
    if (signals.length === 1) return new Promise<Response>((resolve) => { release = resolve; });
    assert.equal(signals[0].aborted, true); return success();
  }, { policy: { ...policy, requestTimeoutMs: 20 }, wait: async () => {} });
  const result = await client.complete(request); release(success());
  assert.equal(result.toolCalls?.[0].name, "vote"); assert.equal(signals.length, 2);
  assert.equal(records.find((a) => a.status === "unknown")?.code, "timeout");
});

test("network failures and malformed responses retry without leaking provider details", async () => {
  for (const failure of ["network", "malformed"]) {
    let calls = 0; const records: ModelAttempt[] = [];
    const client = new PriorityModelClient(models, async (attempt) => { records.push(attempt); }, async () => {
      if (++calls === 1) { if (failure === "network") throw new TypeError("private-key fetch failed"); return new Response("private-key malformed"); }
      return success();
    }, { policy, wait: async () => {} });
    await client.complete(request); assert.equal(calls, 2); assert.ok(records.some((a) => a.status === "unknown"));
    assert.doesNotMatch(JSON.stringify(records), /private-key/);
  }
});

test("pause cancels retry waits; failed storage checks never dispatch a repeat", async () => {
  const controller = new AbortController(); let waiting!: () => void, calls = 0;
  const entered = new Promise<void>((resolve) => { waiting = resolve; });
  const client = new PriorityModelClient(models, undefined, async () => { calls++; return new Response("busy", { status: 503 }); }, { policy: { ...policy, baseDelayMs: 5000 }, wait: async (ms, signal) => { waiting(); await waitForModelRetry(ms, signal); } });
  const promise = client.complete({ ...request, signal: controller.signal });
  await entered; controller.abort(); await assert.rejects(promise, { name: "AbortError" }); assert.equal(calls, 1);
  calls = 0;
  const storage = new PriorityModelClient(models, async (attempt) => { if (attempt.status !== "started") throw new Error("storage unavailable"); }, async () => { calls++; return new Response("busy", { status: 503 }); }, { policy });
  await assert.rejects(storage.complete(request), /storage unavailable/); assert.equal(calls, 1);
});


test("recovery status is visible in debate but contains no hidden-game actor metadata", () => {
  const people = [1, 2, 3, 4, 5, 6].map((seat) => ({ id: `p${seat}`, agentId: "a", providerId: "", modelId: "", vendor: "Agent", modelName: "伙伴", color: "#123456", seat }));
  const room: RoomRecord = { id: "room", input: { title: "test", topic: "test", mode: "debate", agentIds: ["a", "a"], executionMode: "live", options: DEFAULT_OPTIONS }, status: "running", game: createGame("debate", people.slice(0, 2), DEFAULT_OPTIONS, "test"), error: null, createdAt: "", updatedAt: "" };
  room.modelAttempts = [{ id: "attempt", provider: "openrouter", modelId: "private-model", status: "failed", next: "retry", phaseVersion: room.game.phaseVersion, participantId: "p1", at: "" }];
  assert.equal(publicModelRecovery(room), "retrying");
  room.modelAttempts[0] = { ...room.modelAttempts[0], status: "started", next: undefined, recovery: "fallback" };
  assert.equal(publicModelRecovery(room), "fallback");
  room.modelAttempts[0].status = "succeeded"; assert.equal(publicModelRecovery(room), undefined);
  room.input.mode = "werewolf"; room.game = createGame("werewolf", people, DEFAULT_OPTIONS, "test");
  room.modelAttempts[0] = { ...room.modelAttempts[0], status: "failed", next: "retry", participantId: getPendingParticipantIds(room.game)[0], phaseVersion: room.game.phaseVersion };
  assert.equal(publicModelRecovery(room), undefined);
});
