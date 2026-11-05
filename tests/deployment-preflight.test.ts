import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

test("deployment preflight keeps destination credentials separate and rejects Vercel's anonymous 401", async () => {
  const serviceSecret = "preflight-service-bypass";
  const hubSecret = "preflight-hub-bypass";
  const machineToken = "independent-preflight-machine-token-123456";
  const service = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers["x-vercel-protection-bypass"] !== serviceSecret) {
      response.writeHead(401); response.end(JSON.stringify({ message: "Protected by Vercel Authentication" })); return;
    }
    if (request.url === "/api/v1/health") { response.end(JSON.stringify({ database: "up" })); return; }
    if (request.url !== "/api/v1/internal/hub/records" || request.headers.authorization !== `Bearer ${machineToken}` || request.headers["x-hub-protocol"] !== "2" || request.headers["x-hub-environment"] !== "development") {
      response.writeHead(403); response.end("{}"); return;
    }
    response.end("[]");
  });
  const hub = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.writeHead(401);
    response.end(JSON.stringify(request.headers["x-vercel-protection-bypass"] === hubSecret ? { error: "请先登录 42 账号" } : { message: "Protected by Vercel Authentication" }));
  });
  await Promise.all([new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve)), new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve))]);
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview", HUB_DEPLOYMENT_ENV: "development",
    CLUB_SERVICE_URL: `http://127.0.0.1:${(service.address() as { port: number }).port}/api/v1`,
    HUB_VERIFY_URL: `http://127.0.0.1:${(hub.address() as { port: number }).port}`,
    CLUB_SERVICE_PROTECTION_BYPASS: serviceSecret, HUB_SERVICE_TOKEN: machineToken,
  };
  const run = (bypass: string | undefined) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/verify-deployment.mjs"], { env: { ...env, HUB_VERIFY_PROTECTION_BYPASS: bypass }, windowsHide: true });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
  try {
    const success = await run(hubSecret);
    assert.equal(success.code, 0, success.output);
    assert.match(success.output, /PASS/);
    for (const bypass of [undefined, serviceSecret]) {
      const blocked = await run(bypass);
      assert.notEqual(blocked.code, 0, "A platform 401 must never pass as Hub application authorization");
      assert.match(blocked.output, /Expected the Hub application login check/);
      assert.equal(blocked.output.includes(serviceSecret), false);
      assert.equal(blocked.output.includes(hubSecret), false);
    }
  } finally {
    await Promise.all([new Promise<void>((resolve) => service.close(() => resolve())), new Promise<void>((resolve) => hub.close(() => resolve()))]);
  }
});
