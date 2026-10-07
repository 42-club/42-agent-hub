import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_OPTIONS, type DashboardData, type RoomView } from "../src/domain/types";

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout;
  let value: T | undefined;
  while (Date.now() < end) { value = await read(); if (predicate(value)) return value; await new Promise((done) => setTimeout(done, 120)); }
  throw new Error(`Timed out waiting for coordinator: ${JSON.stringify(value)}`);
}

test("coordinator persists a multi-process round, resumes after restart, and never exposes credentials", { timeout: 65_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-coordinator-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString("hex");
  let child: ChildProcess | undefined;
  let logs = "";
  const api = async <T>(path: string, method = "GET", input?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: input ? JSON.stringify(input) : undefined });
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result as T;
  };
  const start = async () => {
    child = spawn(process.execPath, ["--import", "tsx", "server/coordinator.ts"], {
      cwd: process.cwd(), env: { ...process.env, HUB_STORAGE: "local-test", HUB_DATA_DIR: dataDir, HUB_INTERNAL_TOKEN: token, HUB_COORDINATOR_PORT: String(port), OPENROUTER_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { logs += chunk; });
    child.stderr?.on("data", (chunk) => { logs += chunk; });
    await until(async () => { try { const response = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } }); return response.ok; } catch { if (child?.exitCode !== null) throw new Error(logs); return false; } }, Boolean, 12_000);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const current = child;
    current.kill("SIGTERM");
    await new Promise<void>((done) => { current.once("exit", () => done()); });
  };
  try {
    await start();
    assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);
    let dashboard = await api<DashboardData>("/api/dashboard");
    assert.equal(dashboard.agents.length, 4);
    const key = "local-test-secret-must-not-leak";
    await api(`/api/providers/${dashboard.providers[0].id}`, "PUT", { name: "Test connection", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: key });
    dashboard = await api<DashboardData>("/api/dashboard");
    assert.equal(JSON.stringify(dashboard).includes(key), false);
    const { id } = await api<{ id: string }>("/api/rooms", "POST", { title: "重启恢复测试", topic: "好问题比好答案更重要吗", mode: "debate", agentIds: [dashboard.agents[0].id, dashboard.agents[0].id, dashboard.agents[1].id, dashboard.agents[2].id], executionMode: "demo", options: { ...DEFAULT_OPTIONS, rounds: 3 } });
    const initial = await api<RoomView>(`/api/rooms/${id}`);
    assert.equal(new Set(initial.participants.map((participant) => participant.id)).size, 4);
    assert.equal(initial.participants[0].agentId, initial.participants[1].agentId);
    await api(`/api/rooms/${id}/control`, "POST", { action: "start" });
    await until(() => api<RoomView>(`/api/rooms/${id}`), (room) => room.events.some((event) => event.type === "message") || room.status === "error");
    const paused = await api<RoomView>(`/api/rooms/${id}/control`, "POST", { action: "pause" });
    assert.equal(paused.status, "paused", JSON.stringify(paused));
    const committedIds = paused.events.filter((event) => event.type === "message").map((event) => event.id);
    assert.ok(committedIds.length > 0, logs);
    await stop();
    await start();
    const restored = await api<RoomView>(`/api/rooms/${id}`);
    assert.equal(restored.status, "paused");
    assert.deepEqual(restored.events.filter((event) => event.type === "message").map((event) => event.id), committedIds);
    await api(`/api/rooms/${id}/control`, "POST", { action: "resume" });
    const finished = await until(() => api<RoomView>(`/api/rooms/${id}`), (room) => ["completed", "error"].includes(room.status));
    assert.equal(finished.status, "completed", JSON.stringify(finished));
    for (const eventId of committedIds) assert.equal(finished.events.filter((event) => event.id === eventId).length, 1);
    assert.equal(finished.events.filter((event) => event.type === "message").length, 12);
    const exported = await api<{ room: RoomView }>(`/api/rooms/${id}/export`);
    assert.equal(exported.room.events.length, finished.events.length);
    assert.equal(JSON.stringify(exported).includes(key), false);
    const eventStream = await fetch(`${base}/api/rooms/${id}/events`, { headers: { authorization: `Bearer ${token}` } });
    const reader = eventStream.body!.getReader();
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /event: snapshot/);
    await reader.cancel();
  } finally { await stop(); rmSync(dataDir, { recursive: true, force: true }); }
});
