import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentEnvironment, serviceUrl, validateHubRuntime } from "../scripts/runtime-config.mjs";
import { loadSharedAccountEnv } from "../scripts/shared-env.mjs";
import { accessPolicy } from "../scripts/access-policy.mjs";

test("invalid model provider priority is rejected by runtime and preflight configuration validation", () => {
  assert.throws(() => validateHubRuntime({ NODE_ENV: "test", HUB_MODEL_PROVIDER_PRIORITY: "unknown-secret-value" }), (error: unknown) => error instanceof Error && /HUB_MODEL_PROVIDER_PRIORITY/.test(error.message) && !error.message.includes("unknown-secret-value"));
});

test("database admission fails closed and follows fresh account-service metadata", () => {
  const policy = accessPolicy();
  assert.equal(policy.mode, "self-service");
  assert.equal(policy.canCreateOrganization, false);
  assert.equal(policy.allows({ hubAccessEnabled: true }), true);
  for (const value of [undefined, null, {}, { hubAccessEnabled: false }, { hubAccessEnabled: "true" }]) assert.equal(policy.allows(value), false);
});

test("deployment configuration fails closed instead of falling back to local or production resources", () => {
  assert.throws(() => serviceUrl({ NODE_ENV: "production" }), /CLUB_SERVICE_URL/);
  assert.throws(() => serviceUrl({ NODE_ENV: "production", HUB_DEPLOYMENT_ENV: "production", CLUB_SERVICE_URL: "http://127.0.0.1:4242" }), /HTTPS/);
  assert.throws(() => deploymentEnvironment({ NODE_ENV: "production", VERCEL_ENV: "production" }), /requires/);
  assert.throws(() => deploymentEnvironment({ NODE_ENV: "development", HUB_DEPLOYMENT_ENV: "typo" }), /must be/);
  assert.equal(deploymentEnvironment({ NODE_ENV: "production", VERCEL_ENV: "preview", HUB_DEPLOYMENT_ENV: "production" }), "development");
  assert.throws(() => validateHubRuntime({ NODE_ENV: "development" }), /TOKEN/);
  assert.equal(serviceUrl({ NODE_ENV: "development" }), "http://127.0.0.1:4242/api/v1");
});

test("sibling environment inheritance is explicitly local opt-in", async () => {
  const keys = ["NODE_ENV", "VERCEL", "HUB_LOAD_SHARED_ENV", "CLUB_ENV_DIR", "CLUB_SERVICE_URL", "HUB_SERVICE_TOKEN"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const directory = await mkdtemp(join(tmpdir(), "hub-env-"));
  try {
    for (const key of keys) delete process.env[key];
    await writeFile(join(directory, ".env"), "CLUB_SERVICE_URL=https://sibling.example/api/v1\nHUB_SERVICE_TOKEN=sibling-machine-token-123456789012345\n");
    Object.assign(process.env, { NODE_ENV: "development", CLUB_ENV_DIR: directory });
    loadSharedAccountEnv(); assert.equal(process.env.CLUB_SERVICE_URL, undefined);
    process.env.HUB_LOAD_SHARED_ENV = "true";
    loadSharedAccountEnv(); assert.equal(process.env.CLUB_SERVICE_URL, "https://sibling.example/api/v1");
    delete process.env.CLUB_SERVICE_URL;
    Object.assign(process.env, { NODE_ENV: "production" });
    loadSharedAccountEnv(); assert.equal(process.env.CLUB_SERVICE_URL, undefined);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
