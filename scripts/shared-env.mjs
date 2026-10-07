import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// Only account settings cross the app boundary. Hub settings always take priority.
export function loadSharedAccountEnv() {
  const directory = resolve(process.env.CLUB_ENV_DIR || "../42-agent-service");
  const names = ["CLUB_SERVICE_URL", "HUB_SERVICE_TOKEN"];
  for (const file of [".env.local", ".env"]) {
    let values;
    try { values = parseEnv(readFileSync(resolve(directory, file), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of names) if (!process.env[name] && values[name]) process.env[name] = values[name];
  }
}
