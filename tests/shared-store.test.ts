import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { SharedHubStore } from "../server/shared-store";
import { createGame } from "../src/domain/engine";
import { DEFAULT_OPTIONS } from "../src/domain/types";
import type { RoomRecord } from "../server/store";

test("shared persistence exposes only committed SSE snapshots and fails closed on conflicting writers", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  let release: (() => void) | undefined;
  let conflict = false;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") { response.end(JSON.stringify([...rows.values()])); return; }
    let text = ""; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    const id = request.url!.split("/").at(-1)!;
    if (conflict) { response.writeHead(409); response.end("{}"); return; }
    await new Promise<void>((done) => { release = done; });
    rows.set(id, { ...body, id, version: body.version + 1 });
    response.end(JSON.stringify({ version: body.version + 1 }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const previousUrl = process.env.CLUB_SERVICE_URL, previousToken = process.env.HUB_SERVICE_TOKEN;
  process.env.CLUB_SERVICE_URL = `http://127.0.0.1:${port}`;
  process.env.HUB_SERVICE_TOKEN = "separate-test-machine-token-long-enough";
  try {
    const store = await new SharedHubStore().initialize();
    const people = [0, 1].map((seat) => ({ id: randomUUID(), agentId: "a", providerId: "p", vendor: "test", modelId: "test", modelName: "Agent", color: "#123456", seat: seat + 1 }));
    const room: RoomRecord = { id: randomUUID(), organizationId: randomUUID(), input: { title: "Durability", topic: "Test", mode: "debate", agentIds: ["a", "a"], executionMode: "demo", options: DEFAULT_OPTIONS }, game: createGame("debate", people, DEFAULT_OPTIONS, "Test"), status: "waiting", error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.saveRoom(room);
    assert.equal(store.getRoom(room.id)?.status, "waiting");
    assert.equal(store.getCommittedRoom(room.id), undefined, "SSE must not reveal a write before the backend commits");
    while (!release) await new Promise((done) => setTimeout(done, 5));
    release(); await store.flush();
    assert.equal(store.getCommittedRoom(room.id)?.status, "waiting");
    const restored = await new SharedHubStore().initialize();
    assert.deepEqual(restored.getRoom(room.id), room, "A new worker restores entirely from the shared backend");
    conflict = true;
    store.saveRoom({ ...room, status: "running" });
    await assert.rejects(store.flush(), /409/);
    assert.equal(store.getCommittedRoom(room.id)?.status, "waiting", "SSE keeps only the last confirmed snapshot");
    assert.equal((await new SharedHubStore().initialize()).getRoom(room.id)?.status, "waiting");
  } finally {
    if (previousUrl === undefined) delete process.env.CLUB_SERVICE_URL; else process.env.CLUB_SERVICE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.HUB_SERVICE_TOKEN; else process.env.HUB_SERVICE_TOKEN = previousToken;
    await new Promise<void>((done) => server.close(() => done()));
  }
});
