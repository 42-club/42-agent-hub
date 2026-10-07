import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
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
  while (Date.now() < end) { value = await read(); if (predicate(value)) return value; await new Promise((done) => setTimeout(done, 100)); }
  throw new Error(`Timed out waiting for game: ${JSON.stringify(value)}`);
}

test("both secret-role games run through independent demo core workers to a durable terminal result", { timeout: 65_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-games-"));
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
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const current = child;
    current.kill("SIGTERM");
    await new Promise<void>((done) => { current.once("exit", () => done()); });
  };
  const observedNightSnapshots = new Map<string, string>();
  try {
    child = spawn(process.execPath, ["--import", "tsx", "server/coordinator.ts"], {
      cwd: process.cwd(), env: { ...process.env, HUB_STORAGE: "local-test", HUB_DATA_DIR: dataDir, HUB_INTERNAL_TOKEN: token, HUB_COORDINATOR_PORT: String(port), OPENROUTER_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { logs += chunk; });
    child.stderr?.on("data", (chunk) => { logs += chunk; });
    await until(async () => { try { return (await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } })).ok; } catch { if (child?.exitCode !== null) throw new Error(logs); return false; } }, Boolean, 12_000);
    const dashboard = await api<DashboardData>("/api/dashboard");
    assert.ok(dashboard.providers.every((provider) => !provider.configured));
    const undercoverWord = "SECRET_SPY_TEST_402";
    const civilianWord = "SECRET_CIV_TEST_901";
    const rooms = await Promise.all(["undercover", "werewolf"].map(async (mode) => {
      const count = mode === "werewolf" ? 6 : 4;
      const agentIds = Array.from({ length: count }, (_, index) => dashboard.agents[index % dashboard.agents.length].id);
      const created = await api<{ id: string }>("/api/rooms", "POST", { title: `${mode} integration`, topic: "", mode, executionMode: "demo", agentIds, options: { ...DEFAULT_OPTIONS, werewolfCount: 1, maxRounds: 2, undercoverWord, civilianWord } });
      const initial = await api<RoomView>(`/api/rooms/${created.id}`);
      assert.equal(new Set(initial.participants.map((participant) => participant.id)).size, count);
      assert.ok(initial.participants.every((participant) => !participant.role && !participant.word && participant.pid === undefined));
      assert.doesNotMatch(JSON.stringify(initial), /SECRET_SPY_TEST_402|SECRET_CIV_TEST_901/);
      await api(`/api/rooms/${created.id}/control`, "POST", { action: "start" });
      return created;
    }));
    const completed = await Promise.all(rooms.map(({ id }) => until(async () => {
      const room = await api<RoomView>(`/api/rooms/${id}`);
      assert.equal(room.status === "error", false, `${JSON.stringify(room)}\n${logs}`);
      if (room.status !== "completed" && room.phaseLabel !== "终局复盘") {
        assert.ok(room.participants.every((participant) => !participant.role && !participant.word && participant.pid === undefined));
        assert.doesNotMatch(JSON.stringify(room), /SECRET_SPY_TEST_402|SECRET_CIV_TEST_901|wolfTarget|wolfTeammates|查验结果/);
      }
      if (room.status === "running" && room.phaseLabel === "夜间行动") {
        assert.equal(room.pendingCount, 0);
        assert.equal(room.completedCount, 0);
        assert.ok(room.participants.every((participant) => participant.status === "idle" || participant.status === "eliminated"));
        const key = `${id}:${room.round}`;
        const serialized = JSON.stringify(room);
        const previous = observedNightSnapshots.get(key);
        if (previous) assert.equal(serialized, previous, "Night role transitions or private actions must not change the public room payload");
        else observedNightSnapshots.set(key, serialized);
      }
      return room;
    }, (room) => room.status === "completed", 45_000)));
    assert.ok(observedNightSnapshots.size > 0, "The actual coordinator should expose at least one generic night phase");
    for (const room of completed) {
      assert.ok(room.winner);
      assert.equal(room.phaseLabel, "本场结束");
      assert.equal(room.pendingCount, 0);
      assert.ok(room.participants.every((participant) => participant.role));
      assert.ok(room.events.some((event) => event.type === "message"), "Core workers should commit real game messages");
      assert.ok(room.events.some((event) => event.type === "action"), "The game should resolve a vote");
      assert.ok(room.voting && room.voting.history.length > 0, "The public API should expose resolved ballots for the game panel");
      assert.equal(room.voting.phase, "idle");
      const participantIds = new Set(room.participants.map((participant) => participant.id));
      for (const ballot of room.voting.history) {
        assert.equal(new Set(ballot.votes.map((vote) => vote.voterId)).size, ballot.votes.length);
        assert.ok(ballot.votes.every((vote) => participantIds.has(vote.voterId) && participantIds.has(vote.targetId) && vote.voterId !== vote.targetId));
      }
      assert.equal(new Set(room.events.map((event) => event.id)).size, room.events.length);
      assert.ok(room.events.every((event) => event.visibility === "public"));
      const exported = await api<{ room: RoomView }>(`/api/rooms/${room.id}/export`);
      assert.deepEqual(exported.room, room);
    }
    // A partially delivered host message must merge with the latest state, not
    // overwrite actions committed while the server awaits the request body.
    const debate = await api<{ id: string }>("/api/rooms", "POST", { title: "slow message race", topic: "好问题是否更重要", mode: "debate", executionMode: "demo", agentIds: dashboard.agents.map((agent) => agent.id), options: { ...DEFAULT_OPTIONS, rounds: 2 } });
    const hostBody = JSON.stringify({ content: "主持消息不能覆盖已经确认的行动" });
    let pendingRequest!: ReturnType<typeof httpRequest>;
    const delivered = new Promise<number>((resolve, reject) => {
      pendingRequest = httpRequest(`${base}/api/rooms/${debate.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(hostBody) } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
      });
      pendingRequest.once("error", reject);
      pendingRequest.write(hostBody.slice(0, 1));
    });
    try {
      await new Promise((done) => setTimeout(done, 80));
      await api(`/api/rooms/${debate.id}/control`, "POST", { action: "start" });
      const committed = await until(() => api<RoomView>(`/api/rooms/${debate.id}`), (room) => room.events.some((event) => event.type === "message"));
      const committedIds = committed.events.filter((event) => event.type === "message").map((event) => event.id);
      pendingRequest.end(hostBody.slice(1));
      assert.equal(await delivered, 401, "Legacy anonymous host messages cannot bypass a human seat");
      const afterMessage = await api<RoomView>(`/api/rooms/${debate.id}`);
      assert.notEqual(afterMessage.status, "waiting", "A slow host-message body must not restore the earlier room status");
      for (const eventId of committedIds) assert.ok(afterMessage.events.some((event) => event.id === eventId && event.type === "message"), "A durable Agent action was overwritten by a stale host-message snapshot");
      const done = await until(() => api<RoomView>(`/api/rooms/${debate.id}`), (room) => ["completed", "error"].includes(room.status));
      assert.equal(done.status, "completed");
      assert.equal(done.events.filter((event) => event.type === "message").length, 8);
    } finally { pendingRequest.destroy(); await delivered.catch(() => undefined); }
  } finally { await stop(); rmSync(dataDir, { recursive: true, force: true }); }
});
