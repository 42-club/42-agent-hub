import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCoordinator } from "../server/coordinator-runtime";
import { HubStore } from "../server/store";
import type { AgentEntity, DashboardData } from "../src/domain/types";

test("system personas are shared; personal ownership, snapshots and deployment boundaries are enforced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hub-personas-"));
  const store = new HubStore(directory, false);
  const token = randomUUID(), organizationId = randomUUID(), ownerId = randomUUID(), otherId = randomUUID();
  const runtime = await createCoordinator({ token, dataDir: directory, store, cloud: true });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  async function api(path: string, method = "GET", input?: unknown, expected = 200, userId = ownerId, org = organizationId) {
    const response = await fetch(`${base}/api/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-hub-user-id": userId, "x-hub-organization-id": org, "x-hub-role": "owner" }, body: input ? JSON.stringify(input) : undefined });
    const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
  }
  const previousNodeEnv = process.env.NODE_ENV, previousVercel = process.env.VERCEL;
  try {
    let initialIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const dashboard: DashboardData = await api("dashboard", "GET", undefined, 200, randomUUID());
      assert.equal(dashboard.agents.length, 4);
      const ids = dashboard.agents.map((agent) => agent.id);
      if (i) assert.deepEqual(ids, initialIds); else initialIds = ids;
      assert.equal("providers" in dashboard, false);
      assert.ok(dashboard.agents.every((agent) => !Object.hasOwn(agent, "modelId") && !Object.hasOwn(agent, "providerId")));
    }
    assert.equal(store.listAgents().length, 0, "100 users must not create 400 persisted copies");
    await api("providers", "POST", { apiKey: "key" }, 404);
    await api("models", "GET", undefined, 404);
    await api(`agents/${initialIds[0]}`, "PUT", { name: "overwrite" }, 403);
    await api("agents", "POST", { name: "invalid", providerId: "forged" }, 400);
    const agent: AgentEntity = await api("agents", "POST", { name: "私人伙伴", instructions: "OWNER_PRIVATE_INSTRUCTIONS", description: "我的设定" });
    assert.equal(store.listAgents().length, 1);
    assert.equal(agent.source, "personal"); assert.equal(agent.ownerId, ownerId);
    assert.equal((await api("dashboard")).agents.length, 5);
    assert.equal((await api("dashboard", "GET", undefined, 200, otherId)).agents.length, 4);
    await api(`agents/${agent.id}`, "PUT", { name: "stolen" }, 404, otherId);
    await api(`agents/${agent.id}`, "DELETE", undefined, 404, otherId);
    const input = { title: "Persona snapshots", topic: "测试", mode: "debate", agentIds: [agent.id, initialIds[0]], options: { rounds: 1 } };
    await api("rooms", "POST", input, 400, otherId);
    const { id } = await api("rooms", "POST", input, 201);
    const view = await api(`rooms/${id}`, "GET", undefined, 200, otherId);
    assert.equal(JSON.stringify(view).includes("OWNER_PRIVATE_INSTRUCTIONS"), false);
    assert.equal(view.participants[0].agentSnapshot, undefined);
    const exported = await api(`rooms/${id}/export`, "GET", undefined, 200, otherId);
    assert.equal(JSON.stringify(exported).includes("OWNER_PRIVATE_INSTRUCTIONS"), false);
    assert.equal(store.getRoom(id)!.game.participants[0].agentSnapshot?.instructions, "OWNER_PRIVATE_INSTRUCTIONS");
    await api(`agents/${agent.id}`, "PUT", { name: "新版", instructions: "NEW_INSTRUCTIONS" });
    assert.equal(store.getRoom(id)!.game.participants[0].modelName, "私人伙伴");
    assert.equal(store.getRoom(id)!.game.participants[0].agentSnapshot?.version, 1);
    assert.equal((await api("dashboard", "GET", undefined, 200, ownerId, randomUUID())).agents.length, 5, "personal definitions follow the owner across their admitted organizations");
    await api(`agents/${agent.id}`, "DELETE");
    assert.equal((await api(`rooms/${id}`)).participants[0].modelName, "私人伙伴");
    await api(`rooms/${id}`, "GET", undefined, 404, ownerId, randomUUID());
    const legacy = store.getRoom(id)!;
    legacy.status = "running";
    delete legacy.game.participants[0].agentSnapshot;
    store.saveRoom(legacy);
    assert.equal(await runtime.tick(id, 0), false, "old workflows must terminate without requeueing or billing");
    Object.assign(process.env, { NODE_ENV: "production" });
    assert.equal((await api(`rooms/${id}`)).readOnly, true);
    await api(`rooms/${id}/seat`, "POST", {}, 409);
    await api("rooms", "POST", { ...input, agentIds: initialIds.slice(0, 2), executionMode: "demo" }, 400);
    Object.assign(process.env, { NODE_ENV: "test" }); process.env.VERCEL = "1";
    await api("rooms", "POST", { ...input, agentIds: initialIds.slice(0, 2), executionMode: "demo" }, 400);
  } finally {
    Object.assign(process.env, { NODE_ENV: previousNodeEnv });
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
    await runtime.close(); await rm(directory, { recursive: true, force: true });
  }
});
