import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AgentExecutionError, AgentProcessManager, resolveAgentTimeoutMs, type AgentRunInput } from "../server/agent-process-manager";
import type { Participant, ToolSpec } from "../src/domain/types";

const participant = (id: string, seat = 1): Participant => ({ id, agentId: id, providerId: "provider", vendor: "test", modelId: "test/same-model", modelName: "Same model", color: "#aaa", seat });
const speech: ToolSpec = { name: "send_group_message", description: "群聊发言", inputSchema: { type: "object", properties: { channelId: { type: "string", enum: ["public"] }, content: { type: "string" } }, required: ["channelId", "content"], additionalProperties: false } };
function input(id: string, extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return { roomId: "room", participant: participant(id), provider: { kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", apiKey: "unused-in-demo" }, executionMode: "demo", phaseVersion: 1, prompt: `仅供 ${id} 阅读的秘密。请公开发言。`, tools: [speech], requiredTool: speech.name, onAction: async () => ({ accepted: true, turnComplete: true }), ...extra };
}
async function sessionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sessionFiles(path));
    else if (entry.name.endsWith(".json")) files.push(path);
  }
  return files;
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test("each Agent forks its own process and core session, even with the same model", { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hub-process-isolation-"));
  const manager = new AgentProcessManager({ dataDir });
  const actions: { id: string; args: Record<string, unknown>; actionId: string }[] = [];
  try {
    await Promise.all(["first", "second"].map((id) => manager.run(input(id, { onAction: async (name, args, actionId) => {
      assert.equal(name, speech.name); actions.push({ id, args, actionId }); return { turnComplete: true };
    } }))));
    const first = manager.getPid("room", "first")!;
    const second = manager.getPid("room", "second")!;
    assert.ok(first && second && first !== second && first !== process.pid && second !== process.pid);
    assert.equal(actions.length, 2);
    assert.equal(new Set(actions.map((action) => action.actionId)).size, 2);
    for (const action of actions) { assert.equal(action.args.channelId, "public"); assert.match(String(action.args.content), /离线示例/); }
    const files = await sessionFiles(dataDir);
    assert.equal(files.length, 2);
    for (const file of files) {
      const raw = await readFile(file, "utf8");
      const session = JSON.parse(raw.slice(raw.indexOf("\n") + 1)).session;
      assert.equal(session.runState.status, "completed");
      assert.equal(session.runState.toolCalls[0].status, "completed");
      assert.match(raw, /hub.participant/);
      const own = session.id;
      const other = own === "first" ? "second" : "first";
      assert.ok(raw.includes(`仅供 ${own} 阅读的秘密`));
      assert.ok(!raw.includes(`仅供 ${other} 阅读的秘密`));
      assert.ok(!raw.includes("unused-in-demo"));
    }
    await manager.run(input("first", { phaseVersion: 2 }));
    assert.equal(manager.getPid("room", "first"), first, "seat retains its own process between rounds");
    await manager.closeRoom("room");
    assert.equal(alive(first), false);
    assert.equal(alive(second), false);
    assert.equal(manager.getPid("room", "first"), undefined);
  } finally { await manager.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("cancellation rejects the active run and reaps its process even during a pending tool", { timeout: 15_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hub-process-cancel-"));
  const manager = new AgentProcessManager({ dataDir });
  const controller = new AbortController();
  let reached!: () => void;
  const ready = new Promise<void>((done) => { reached = done; });
  try {
    const run = manager.run(input("cancelled", { signal: controller.signal, onAction: async () => { reached(); return new Promise(() => {}); } }));
    const rejected = assert.rejects(run, { name: "AbortError" });
    await ready;
    const pid = manager.getPid("room", "cancelled")!;
    controller.abort();
    await rejected;
    await manager.cancelRoom("room");
    assert.equal(alive(pid), false);
  } finally { await manager.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("unexpected process death rejects its waiter and a fresh process recovers the core session", { timeout: 15_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hub-process-crash-"));
  const manager = new AgentProcessManager({ dataDir });
  let reached!: () => void;
  const ready = new Promise<void>((done) => { reached = done; });
  try {
    const run = manager.run(input("crashed", { onAction: async () => { reached(); return new Promise(() => {}); } }));
    const rejected = assert.rejects(run, /意外退出/);
    await ready;
    const previous = manager.getPid("room", "crashed")!;
    process.kill(previous, "SIGKILL");
    await rejected;
    let newActions = 0;
    await manager.run(input("crashed", { phaseVersion: 2, prompt: "新阶段，只执行当前行动，不重放历史行动", onAction: async () => { newActions++; return { turnComplete: true }; } }));
    assert.equal(newActions, 1);
    assert.notEqual(manager.getPid("room", "crashed"), previous);
    const raw = await readFile((await sessionFiles(dataDir))[0], "utf8");
    assert.match(raw, /InterruptedToolCall/);
  } finally { await manager.close(); await rm(dataDir, { recursive: true, force: true }); }
});

async function providerServer(handle: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void) {
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    handle(request, response, text ? JSON.parse(text) : {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, close: async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
function stream(response: ServerResponse, delta: Record<string, unknown>) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
}

test("live OpenAI-compatible streams go through core and a game-provided alternate tool can finish a turn", { timeout: 15_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hub-process-live-"));
  const manager = new AgentProcessManager({ dataDir });
  const requests: Record<string, unknown>[] = [];
  const mock = await providerServer((request, response, body) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer mock-secret");
    requests.push(body);
    stream(response, { content: "这段模型原文不应公开", tool_calls: [{ index: 0, id: "provider-call-1", type: "function", function: { name: "use_antidote", arguments: "{}" } }] });
  });
  try {
    const actions: string[] = [];
    await manager.run(input("witch", { executionMode: "live", provider: { kind: "openai-compatible", baseUrl: mock.baseUrl, apiKey: "mock-secret" }, requiredTool: "pass", tools: ["pass", "use_antidote"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: false } })), onAction: async (name) => { actions.push(name); return { accepted: true, turnComplete: true }; } }));
    assert.deepEqual(actions, ["use_antidote"]);
    assert.equal(requests.length, 1, "no additional billed request after durable terminal action");
    assert.equal(requests[0].model, "test/same-model");
    assert.equal(requests[0].stream, true);
    assert.equal(requests[0].max_tokens, 2048);
    assert.deepEqual((requests[0].tools as { function: { name: string } }[]).map((tool) => tool.function.name), ["pass", "use_antidote"]);
  } finally { await manager.close(); await mock.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("plain model text cannot complete a required action, and retries are finite", { timeout: 15_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hub-process-missing-action-"));
  const manager = new AgentProcessManager({ dataDir });
  let requests = 0;
  const mock = await providerServer((_request, response) => { requests++; stream(response, { content: "我已投票（并未调用工具）" }); });
  try {
    let actions = 0;
    await assert.rejects(manager.run(input("plain", { executionMode: "live", provider: { kind: "openai-compatible", baseUrl: mock.baseUrl, apiKey: "mock-secret" }, onAction: async () => { actions++; } })), /未提交/);
    assert.equal(requests, 2);
    assert.equal(actions, 0);
  } finally { await manager.close(); await mock.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("authentication errors are classified without exposing provider text or credentials", { timeout: 15_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hub-process-error-"));
  const manager = new AgentProcessManager({ dataDir });
  const mock = await providerServer((_request, response) => { response.writeHead(401); response.end("sensitive-error-api-key-123"); });
  try {
    await assert.rejects(manager.run(input("error", { executionMode: "live", provider: { kind: "openai-compatible", baseUrl: mock.baseUrl, apiKey: "sensitive-error-api-key-123" } })), (error: Error) => {
      assert.ok(error instanceof AgentExecutionError);
      assert.equal(error.code, "authentication");
      assert.ok(!error.message.includes("sensitive-error")); assert.match(error.message, /认证失败/); return true;
    });
  } finally { await manager.close(); await mock.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("rate limits are classified without exposing raw provider errors", { timeout: 15_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hub-process-rate-limit-"));
  const manager = new AgentProcessManager({ dataDir });
  const mock = await providerServer((_request, response) => { response.writeHead(429); response.end("private-provider-diagnostics-and-key"); });
  try {
    await assert.rejects(manager.run(input("limited", { executionMode: "live", provider: { kind: "openai-compatible", baseUrl: mock.baseUrl, apiKey: "mock-secret" } })), (error: Error) => {
      assert.ok(error instanceof AgentExecutionError);
      assert.equal(error.code, "rate_limit");
      assert.ok(!error.message.includes("private-provider"));
      assert.match(error.message, /过于频繁/);
      return true;
    });
  } finally { await manager.close(); await mock.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("payment and upstream outages receive specific safe error categories", { timeout: 20_000 }, async () => {
  for (const [status, code] of [[402, "insufficient_credits"], [503, "service_unavailable"]] as const) {
    const dataDir = await mkdtemp(join(tmpdir(), "hub-process-status-"));
    const manager = new AgentProcessManager({ dataDir });
    const mock = await providerServer((_request, response) => { response.writeHead(status); response.end("private-provider-diagnostics-and-key"); });
    try {
      await assert.rejects(manager.run(input(`status-${status}`, { executionMode: "live", provider: { kind: "openai-compatible", baseUrl: mock.baseUrl, apiKey: "mock-secret" } })), (error: Error) => {
        assert.ok(error instanceof AgentExecutionError);
        assert.equal(error.code, code);
        assert.ok(!error.message.includes("private-provider"));
        return true;
      });
    } finally { await manager.close(); await mock.close(); await rm(dataDir, { recursive: true, force: true }); }
  }
});

test("Agent deadlines default to 180 seconds and server overrides are bounded", () => {
  assert.equal(resolveAgentTimeoutMs(""), 180_000);
  assert.equal(resolveAgentTimeoutMs("not-a-number"), 180_000);
  assert.equal(resolveAgentTimeoutMs("Infinity"), 180_000);
  assert.equal(resolveAgentTimeoutMs("90000"), 90_000);
  assert.equal(resolveAgentTimeoutMs("0"), 10_000);
  assert.equal(resolveAgentTimeoutMs("999999"), 300_000);
});

test("core rejects invalid targets before IPC and phase tools are replaced, not accumulated", { timeout: 15_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hub-process-scopes-"));
  const manager = new AgentProcessManager({ dataDir });
  let count = 0;
  const mock = await providerServer((_request, response, body) => {
    count++;
    const names = (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    assert.deepEqual(names, count === 1 ? ["send_group_message"] : ["vote"]);
    const name = count === 1 ? "send_group_message" : "vote";
    const args = count === 1 ? { channelId: "public", content: "第一阶段发言" } : { targetId: count === 2 ? "forbidden" : "valid-target" };
    stream(response, { tool_calls: [{ index: 0, id: `call-${count}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  });
  const provider = { kind: "openai-compatible" as const, baseUrl: mock.baseUrl, apiKey: "mock-secret" };
  try {
    const actions: string[] = [];
    await manager.run(input("scoped", { executionMode: "live", provider, onAction: async (name) => { actions.push(name); return { turnComplete: true }; } }));
    await manager.run(input("scoped", { phaseVersion: 2, executionMode: "live", provider, requiredTool: "vote", tools: [{ name: "vote", description: "投票", inputSchema: { type: "object", properties: { targetId: { type: "string", enum: ["valid-target"] } }, required: ["targetId"], additionalProperties: false } }], onAction: async (name, args) => { assert.equal(args.targetId, "valid-target"); actions.push(name); return { turnComplete: true }; } }));
    assert.deepEqual(actions, ["send_group_message", "vote"]);
    assert.equal(count, 3);
  } finally { await manager.close(); await mock.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("a killed coordinator cannot leave an orphaned Agent process", { timeout: 15_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hub-process-orphan-"));
  const driver = join(dataDir, "parent.mts");
  const managerUrl = new URL("../server/agent-process-manager.ts", import.meta.url).href;
  await writeFile(driver, `import { AgentProcessManager } from ${JSON.stringify(managerUrl)};
const manager = new AgentProcessManager({dataDir:${JSON.stringify(dataDir)}});
manager.run({...${JSON.stringify(input("orphan"))},onAction:async()=>{
  process.send({pid:manager.getPid("room","orphan")});
  return new Promise(()=>{});
}}).catch(()=>{});
`);
  const parent = fork(driver, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let pid: number | undefined;
  try {
    pid = await new Promise<number>((done, reject) => {
      parent.once("message", (value: { pid: number }) => done(value.pid));
      parent.once("error", reject);
      parent.once("exit", () => reject(new Error("coordinator exited before starting its Agent")));
    });
    assert.ok(alive(pid));
    const exited = new Promise<void>((done) => parent.once("exit", () => done()));
    parent.kill("SIGKILL");
    await exited;
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
    assert.equal(alive(pid), false);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(dataDir, { recursive: true, force: true });
  }
});
