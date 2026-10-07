import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoordinator } from "./coordinator-runtime";

export async function cloudRequest(path: string, init: { method: string; headers: Record<string,string>; body?: string }) {
  const dataDir = await mkdtemp(join(tmpdir(), "42-hub-request-"));
  const token = randomBytes(32).toString("hex");
  let runtime: Awaited<ReturnType<typeof createCoordinator>> | undefined;
  try {
    runtime = await createCoordinator({ token, dataDir, cloud: true });
    await new Promise<void>((done) => runtime!.server.listen(0, "127.0.0.1", done));
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("无法启动执行适配器");
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
    const bytes = await response.arrayBuffer();
    const headers = new Headers({ "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store" });
    const disposition = response.headers.get("content-disposition"); if(disposition)headers.set("content-disposition",disposition);
    return new Response(bytes, { status: response.status, headers });
  } finally {
    try { await runtime?.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  }
}

/** One durable phase per step; human turns finish the run and resume after their next action. */
export async function runCloudTick(roomId: string, generation: number) {
  const dataDir = await mkdtemp(join(tmpdir(), "42-hub-step-"));
  let runtime: Awaited<ReturnType<typeof createCoordinator>> | undefined;
  try {
    runtime = await createCoordinator({ token: randomBytes(32).toString("hex"), dataDir, cloud: true });
    return await runtime.tick(roomId, generation);
  } finally {
    try { await runtime?.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  }
}
