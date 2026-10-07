import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadSharedAccountEnv } from "./shared-env.mjs";

try { process.loadEnvFile(".env.local"); } catch (error) { if (error.code !== "ENOENT") throw error; }
try { process.loadEnvFile(".env"); } catch (error) { if (error.code !== "ENOENT") throw error; }
loadSharedAccountEnv();

const mode = process.argv[2] === "start" ? "start" : "dev";
const port = process.env.PORT ?? "3000";
const coordinatorPort = process.env.HUB_COORDINATOR_PORT ?? "4317";
const token = randomBytes(32).toString("hex");
const env = { ...process.env, NODE_ENV: mode === "dev" ? "development" : "production", HUB_INTERNAL_TOKEN: token, HUB_COORDINATOR_URL: `http://127.0.0.1:${coordinatorPort}`, HUB_COORDINATOR_PORT: coordinatorPort, HUB_DATA_DIR: resolve(process.env.HUB_DATA_DIR ?? ".data") };
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); process.exit(code); }, 6000);
  Promise.all(children.map((child) => new Promise((done) => { if (child.exitCode !== null) done(); else child.once("exit", done); }))).then(() => { clearTimeout(timer); process.exit(code); });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
const coordinator = spawn(process.execPath, ["--import", "tsx", "server/coordinator.ts"], { env, stdio: "inherit" });
children.push(coordinator);
coordinator.on("error", (error) => { console.error(error.message); stop(1); });
coordinator.on("exit", (code) => { if (!stopping) stop(code ?? 1); });

let ready = false;
for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
  try {
    const response = await fetch(`${env.HUB_COORDINATOR_URL}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
    if (response.ok) { ready = true; break; }
  } catch {}
  await new Promise((done) => setTimeout(done, 250));
}
if (!ready) { console.error("房间服务未能启动，请检查上方错误。"); stop(1); }
else {
  const web = spawn(process.execPath, ["node_modules/next/dist/bin/next", mode, "--hostname", process.env.HUB_HOST ?? "127.0.0.1", "--port", port], { env, stdio: "inherit" });
  children.push(web);
  web.on("error", (error) => { console.error(error.message); stop(1); });
  web.on("exit", (code) => { if (!stopping) stop(code ?? 1); });
}
