import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ClubError, clubRequest } from "../src/lib/club-service";
import { SharedHubStore, StorageError } from "../server/shared-store";
import { serviceRequest } from "../scripts/service-request.mjs";

test("protected Service transport preserves account and storage authentication", async (t) => {
  const keys = ["CLUB_SERVICE_URL", "CLUB_SERVICE_PROTECTION_BYPASS", "VERCEL_AUTOMATION_BYPASS_SECRET", "HUB_SERVICE_TOKEN", "NODE_ENV", "VERCEL", "VERCEL_ENV", "HUB_DEPLOYMENT_ENV"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const serviceSecret = "service-project-test-bypass";
  const machineToken = "independent-machine-token-for-storage-123456";
  const seen: { path: string; method: string; headers: Record<string, unknown>; body: string }[] = [];
  let mode = "protected";
  let redirects = 0;
  const redirectTarget = createServer((_request, response) => { redirects++; response.end("unexpected"); });
  await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
  const redirectPort = (redirectTarget.address() as { port: number }).port;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ path: request.url!, method: request.method!, headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    if (mode === "redirect") {
      response.writeHead(302, { location: `http://127.0.0.1:${redirectPort}/sso` });
      response.end(); return;
    }
    if (mode === "html") {
      response.setHeader("content-type", "text/html");
      response.end("<html>Vercel login page with private details</html>"); return;
    }
    if (mode === "invalid") { response.end("not-json-private-details"); return; }
    if (mode === "protected" && request.headers["x-vercel-protection-bypass"] !== serviceSecret) {
      response.writeHead(401);
      response.end(JSON.stringify({ message: "Protected by Vercel Authentication" })); return;
    }
    if (mode === "unauthorized") {
      response.writeHead(401);
      response.end(JSON.stringify({ message: "Invalid session" })); return;
    }
    if (mode === "rate-limit") {
      response.writeHead(429);
      response.end(JSON.stringify({ message: ["Too many attempts"], retryAfterSeconds: 60, retryAt: "2026-11-04T00:01:00Z" })); return;
    }
    if (mode === "conflict") { response.writeHead(409); response.end("{}"); return; }
    if (request.url!.startsWith("/api/v1/internal/hub/records")) {
      response.end(JSON.stringify(request.method === "GET" ? [] : { version: 1 })); return;
    }
    response.end(JSON.stringify({ verificationRequired: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    Object.assign(process.env, {
      CLUB_SERVICE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`,
      HUB_SERVICE_TOKEN: machineToken,
      NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview", HUB_DEPLOYMENT_ENV: "development",
      VERCEL_AUTOMATION_BYPASS_SECRET: "hub-project-secret-must-not-be-used",
    });
    delete process.env.CLUB_SERVICE_PROTECTION_BYPASS;

    await t.test("Vercel's 401 is an upstream configuration failure, not an expired user session", async () => {
      await assert.rejects(clubRequest("/auth/register", { method: "POST", body: {} }), (error: unknown) => error instanceof ClubError && error.status === 503 && /部署保护/.test(error.message));
      await assert.rejects(new SharedHubStore().initialize(), (error: unknown) => error instanceof StorageError && error.status === 503 && error.kind === "permission" && /部署保护/.test(error.message));
      assert.equal(seen.at(-1)!.headers["x-vercel-protection-bypass"], undefined);
    });

    await t.test("one Service bypass reaches registration, authenticated account reads, and storage reads/writes", async () => {
      process.env.CLUB_SERVICE_PROTECTION_BYPASS = ` ${serviceSecret} `;
      const input = { email: "fixture@example.com", displayName: "Fixture", password: "test-only-password" };
      assert.deepEqual(await clubRequest("/auth/register", { method: "POST", body: input, headers: { "x-hub-client-signature": "signed-attribution" } }), { verificationRequired: true });
      assert.equal(seen.at(-1)!.path, "/api/v1/auth/register");
      assert.equal(seen.at(-1)!.method, "POST");
      assert.deepEqual(JSON.parse(seen.at(-1)!.body), input);
      assert.equal(seen.at(-1)!.headers["x-hub-client-signature"], "signed-attribution");
      await clubRequest("/auth/me", { token: "user-session" });
      assert.equal(seen.at(-1)!.headers.authorization, "Bearer user-session");
      const store = await new SharedHubStore().initialize();
      assert.deepEqual(store.listRooms(), []);
      assert.deepEqual(await store.request("/fixture", "PUT", { version: 0 }), { version: 1 });
      const last = seen.at(-1)!;
      assert.equal(last.path, "/api/v1/internal/hub/records/fixture");
      assert.equal(last.headers.authorization, `Bearer ${machineToken}`);
      assert.equal(last.headers["x-hub-protocol"], "2");
      assert.equal(last.headers["x-hub-environment"], "development");
      assert.deepEqual(JSON.parse(last.body), { version: 0 });
      for (const request of seen.slice(-4)) assert.equal(request.headers["x-vercel-protection-bypass"], serviceSecret);
    });

    await t.test("unconfigured and blank bypass preserve calls to an unprotected Service", async () => {
      mode = "open";
      for (const value of [undefined, "   "]) {
        if (value === undefined) delete process.env.CLUB_SERVICE_PROTECTION_BYPASS;
        else process.env.CLUB_SERVICE_PROTECTION_BYPASS = value;
        await clubRequest("/auth/me", { token: "existing-session" });
        assert.equal(seen.at(-1)!.headers.authorization, "Bearer existing-session");
        assert.equal(seen.at(-1)!.headers["x-vercel-protection-bypass"], undefined);
        await new SharedHubStore().initialize();
        assert.equal(seen.at(-1)!.headers.authorization, `Bearer ${machineToken}`);
        assert.equal(seen.at(-1)!.headers["x-vercel-protection-bypass"], undefined);
      }
    });

    await t.test("application session expiry, cooldown and storage conflicts keep their original status", async () => {
      process.env.CLUB_SERVICE_PROTECTION_BYPASS = serviceSecret;
      mode = "unauthorized";
      await assert.rejects(clubRequest("/auth/me"), (error: unknown) => error instanceof ClubError && error.status === 401 && error.message === "Invalid session");
      await assert.rejects(new SharedHubStore().request(""), (error: unknown) => error instanceof StorageError && error.status === 401 && error.kind === "permission");
      mode = "rate-limit";
      await assert.rejects(clubRequest("/auth/login", { method: "POST", body: {} }), (error: unknown) => error instanceof ClubError && error.status === 429 && error.retryAfterSeconds === 60 && error.retryAt === "2026-11-04T00:01:00Z" && error.message === "Too many attempts");
      mode = "conflict";
      await assert.rejects(new SharedHubStore().request("/fixture", "PUT", {}), (error: unknown) => error instanceof StorageError && error.status === 409 && error.kind === "conflict");
    });

    await t.test("redirects are never followed, even when requested by a caller", async () => {
      mode = "redirect";
      await assert.rejects(serviceRequest("/health", { redirect: "follow" }), /重定向/);
      await assert.rejects(clubRequest("/auth/register", { method: "POST", body: {} }), (error: unknown) => error instanceof ClubError && error.status === 503 && /重定向/.test(error.message));
      assert.equal(redirects, 0, "No bypass, user token or registration payload may reach the redirect target");
    });

    await t.test("HTML and malformed JSON become safe configuration errors", async () => {
      for (const value of ["html", "invalid"]) {
        mode = value;
        await assert.rejects(clubRequest("/auth/me"), (error: unknown) => error instanceof ClubError && error.status === 503 && /JSON/.test(error.message) && !error.message.includes("private-details"));
        await assert.rejects(new SharedHubStore().request(""), (error: unknown) => error instanceof StorageError && error.status === 503 && /JSON/.test(error.message));
      }
    });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => redirectTarget.close(() => resolve()))]);
  }
});
