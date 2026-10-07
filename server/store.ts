import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentEntity, CreateRoomInput, ProviderConnection, RoomStatus } from "../src/domain/types";
import type { GameState } from "../src/domain/engine";

export interface RoomRecord {
  executionGeneration?: number;
  requests?: Record<string, string>;
  cloudAttempt?: { phaseVersion: number; participantIds: string[]; owner?: string; generation?: number };
  organizationId?: string;
  ownerId?: string;
  id: string;
  input: CreateRoomInput;
  status: RoomStatus;
  game: GameState;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

type ProviderRow = { id: string; name: string; kind: ProviderConnection["kind"]; base_url: string; secret: string };

/** Single coordinator is the only writer. Agent processes each own a different core SessionStore. */
export class HubStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  readonly dataDir: string;

  constructor(directory: string, seed = true) {
    this.dataDir = resolve(directory);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const keyPath = join(this.dataDir, "credentials.key");
    try { this.key = readFileSync(keyPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.key = randomBytes(32);
      writeFileSync(keyPath, this.key, { mode: 0o600, flag: "wx" });
    }
    if (this.key.length !== 32) throw new Error("本地凭据密钥损坏，请恢复数据目录备份");
    const dbPath = join(this.dataDir, "hub.sqlite");
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL, secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (seed && !this.db.prepare("SELECT value FROM metadata WHERE key = 'seeded'").get()) this.seed();
    if (seed && process.env.OPENROUTER_API_KEY) {
      const connection = this.listProviders()[0];
      if (connection && !connection.configured) this.saveProvider({ name: "OpenRouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY }, connection.id);
    }
  }

  private encrypt(value: string): string {
    if (!value) return "";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  private decrypt(value: string): string {
    if (!value) return "";
    const data = Buffer.from(value, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
  }

  listProviders(): ProviderConnection[] {
    return (this.db.prepare("SELECT * FROM providers ORDER BY rowid").all() as ProviderRow[])
      .map((row) => ({ id: row.id, name: row.name, kind: row.kind, baseUrl: row.base_url, configured: Boolean(row.secret) }));
  }

  getProvider(id: string): (ProviderConnection & { apiKey: string }) | undefined {
    const row = this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow | undefined;
    return row ? { id: row.id, name: row.name, kind: row.kind, baseUrl: row.base_url, configured: Boolean(row.secret), apiKey: this.decrypt(row.secret) } : undefined;
  }

  saveProvider(input: Omit<ProviderConnection, "id" | "configured"> & { apiKey?: string }, id: string = randomUUID()): ProviderConnection {
    const previous = this.db.prepare("SELECT secret FROM providers WHERE id = ?").get(id) as { secret: string } | undefined;
    const secret = input.apiKey === undefined || input.apiKey === "" ? previous?.secret ?? "" : this.encrypt(input.apiKey);
    this.db.prepare("INSERT INTO providers VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, base_url=excluded.base_url, secret=excluded.secret")
      .run(id, input.name, input.kind, input.baseUrl.replace(/\/+$/, ""), secret);
    return this.listProviders().find((provider) => provider.id === id)!;
  }

  deleteProvider(id: string) { this.db.prepare("DELETE FROM providers WHERE id = ?").run(id); }
  listAgents(): AgentEntity[] { return (this.db.prepare("SELECT data FROM agents ORDER BY rowid").all() as { data: string }[]).map((row) => JSON.parse(row.data)); }
  getAgent(id: string): AgentEntity | undefined { return this.listAgents().find((agent) => agent.id === id); }
  saveAgent(agent: AgentEntity) { this.db.prepare("INSERT INTO agents VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(agent.id, JSON.stringify(agent)); }
  deleteAgent(id: string) { this.db.prepare("DELETE FROM agents WHERE id = ?").run(id); }
  listRooms(): RoomRecord[] { return (this.db.prepare("SELECT data FROM rooms ORDER BY rowid DESC").all() as { data: string }[]).map((row) => JSON.parse(row.data)); }
  getRoom(id: string): RoomRecord | undefined {
    const row = this.db.prepare("SELECT data FROM rooms WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  getCommittedRoom(id: string) { return this.getRoom(id); }
  saveRoom(room: RoomRecord) {
    this.db.prepare("INSERT INTO rooms VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(room.id, JSON.stringify(room));
  }
  async flush(_id?: string) {}
  close() { this.db.close(); }

  private seed() {
    const provider = this.saveProvider({ name: "OpenRouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY ?? "" });
    const models = [
      ["Anthropic", "anthropic/claude-opus-4.6", "Claude Opus 4.6", "#bf8a71"],
      ["OpenAI", "openai/gpt-5.4", "GPT-5.4", "#77977b"],
      ["Google", "google/gemini-3.1-pro-preview", "Gemini 3.1 Pro", "#8294b5"],
      ["DeepSeek", "deepseek/deepseek-v3.2", "DeepSeek V3.2", "#b29ab3"],
    ];
    for (const [vendor, modelId, modelName, color] of models) this.saveAgent({ id: randomUUID(), providerId: provider.id, vendor, modelId, modelName, color, createdAt: new Date().toISOString() });
    this.db.prepare("INSERT INTO metadata VALUES ('seeded', '1')").run();
  }
}
