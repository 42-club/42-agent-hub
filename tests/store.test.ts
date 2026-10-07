import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubStore } from "../server/store";
import { roomSchema } from "../src/domain/validation";
import { DEFAULT_OPTIONS } from "../src/domain/types";

test("credentials are encrypted at rest, omitted from public DTOs, and survive reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-store-"));
  let store = new HubStore(dir, false);
  try {
    const key = "test-secret-do-not-expose-42";
    const provider = store.saveProvider({ name: "Test", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1/", apiKey: key });
    assert.equal(provider.configured, true);
    assert.equal(provider.baseUrl, "http://127.0.0.1:1234/v1");
    assert.equal(JSON.stringify(store.listProviders()).includes(key), false);
    assert.equal(store.getProvider(provider.id)?.apiKey, key);
    store.saveProvider({ name: "Renamed", kind: "openai-compatible", baseUrl: provider.baseUrl }, provider.id);
    assert.equal(store.getProvider(provider.id)?.apiKey, key);
    store.close();
    assert.equal(readFileSync(join(dir, "hub.sqlite")).includes(Buffer.from(key)), false);
    store = new HubStore(dir, false);
    assert.equal(store.getProvider(provider.id)?.apiKey, key);
    assert.equal(store.listProviders()[0].name, "Renamed");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("same model can back multiple independently identified entities", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-entities-"));
  const store = new HubStore(dir, false);
  try {
    for (const id of ["one", "two"]) store.saveAgent({ id, providerId: "provider", vendor: "Vendor", modelId: "same-model", modelName: "Model", color: "#77977b", createdAt: new Date().toISOString() });
    assert.equal(store.listAgents().length, 2);
    store.deleteAgent("one");
    assert.equal(store.getAgent("two")?.modelId, "same-model");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("room validation rejects impossible setups and permits repeated agent seats", () => {
  const common = { title: "Test", topic: "话题", agentIds: ["same", "same", "third", "fourth"], executionMode: "demo", options: DEFAULT_OPTIONS };
  assert.equal(roomSchema.safeParse({ ...common, mode: "debate" }).success, true);
  assert.equal(roomSchema.safeParse({ ...common, mode: "werewolf" }).success, false);
  assert.equal(roomSchema.safeParse({ ...common, mode: "undercover", options: { ...DEFAULT_OPTIONS, undercoverCount: 2 } }).success, false);
  assert.equal(roomSchema.safeParse({ ...common, mode: "undercover", options: { ...DEFAULT_OPTIONS, civilianWord: "相同", undercoverWord: "相同" } }).success, false);
  const eightSeats = { ...common, mode: "werewolf", agentIds: Array.from({ length: 8 }, (_, index) => `seat-${index}`) };
  const extendedOptions = { ...DEFAULT_OPTIONS, hasHunter: true, hasGuard: true, hasBomber: true, hasWolfKing: true, revealRolesAtStart: true };
  assert.equal(roomSchema.safeParse({ ...eightSeats, options: extendedOptions }).success, true);
  assert.equal(roomSchema.safeParse({ ...eightSeats, agentIds: eightSeats.agentIds.slice(0, 7), options: extendedOptions }).success, false);
  const { hasHunter: _hunter, hasGuard: _guard, hasBomber: _bomber, hasWolfKing: _king, ...legacyOptions } = DEFAULT_OPTIONS;
  const parsedLegacy = roomSchema.parse({ ...eightSeats, options: legacyOptions });
  assert.equal(parsedLegacy.options.hasWolfKing, false);
});
