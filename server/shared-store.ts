import { randomUUID } from "node:crypto";
import type { AgentEntity, ProviderConnection } from "../src/domain/types";
import type { RoomRecord } from "./store";

type Provider = ProviderConnection & { apiKey: string; organizationId: string };
export type RecordRow = { id: string; organizationId: string; kind: "room" | "agent" | "provider"; version: number; data: RoomRecord | AgentEntity | Provider };
export class StorageError extends Error {
  constructor(readonly kind: "network" | "permission" | "conflict" | "storage", readonly status = 503) {
    super(kind === "conflict" ? "共享状态已变化 (409)，请重新读取后重试。" : kind === "permission" ? "共享存储拒绝访问，请检查环境和权限配置。" : "共享存储暂时不可用，已确认的行动保留。请稍后重试。");
  }
}
export function hubEnvironment() {
  return process.env.NODE_ENV === "production" && process.env.HUB_DEPLOYMENT_ENV === "production" && (!process.env.VERCEL_ENV || process.env.VERCEL_ENV === "production") ? "production" : "development";
}
export function hubHeaders() { return { authorization: `Bearer ${process.env.HUB_SERVICE_TOKEN ?? ""}`, "content-type": "application/json", "x-hub-protocol": "2", "x-hub-environment": hubEnvironment() }; }

/** Per-record write queues. Failed optimistic state is discarded; recovery always reads authority. */
export class SharedHubStore {
  private versions = new WeakMap<object, number>();
  private committed = new Map<string, RecordRow>();
  private records = new Map<string, RecordRow>();
  private pending = new Map<string, Promise<void>>();
  private failures = new Map<string, Error>();
  private base = `${(process.env.CLUB_SERVICE_URL || "http://127.0.0.1:4242/api/v1").replace(/\/$/, "")}/internal/hub/records`;
  async initialize() {
    if (!process.env.HUB_SERVICE_TOKEN || process.env.HUB_SERVICE_TOKEN.length < 32) throw new Error("请配置独立的 HUB_SERVICE_TOKEN。");
    await this.refresh();
    return this;
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try { response = await fetch(`${this.base}${path}`, { method, headers: hubHeaders(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) }); }
    catch { throw new StorageError("network"); }
    if (!response.ok) throw new StorageError(response.status === 409 ? "conflict" : [401,403].includes(response.status) ? "permission" : "storage", response.status);
    try { const text = await response.text(); return (!text && method === "GET" ? null : JSON.parse(text)) as T; } catch { throw new StorageError("network"); }
  }
  async refresh(id?: string) {
    if (id) {
      await this.pending.get(id);
      const row = await this.request<RecordRow | null>(`/${id}`);
      if (row) { this.records.set(id, structuredClone(row)); this.committed.set(id, structuredClone(row)); }
      else { this.records.delete(id); this.committed.delete(id); }
      this.failures.delete(id);
    } else {
      await Promise.all(this.pending.values());
      const before = new Map([...this.committed].map(([key, row]) => [key, row.version]));
      const rows = await this.request<RecordRow[]>("");
      const present = new Set(rows.map((row) => row.id));
      for (const row of rows) {
        // A list request must not overwrite a commit that completed while it was in flight.
        if (row.version >= (this.committed.get(row.id)?.version ?? 0)) this.committed.set(row.id, structuredClone(row));
        if (this.failures.has(row.id) || row.version >= (this.records.get(row.id)?.version ?? 0)) this.records.set(row.id, structuredClone(row));
        this.failures.delete(row.id);
      }
      for (const [key, version] of before) {
        if (!present.has(key) && this.records.get(key)?.version === version) {
          this.records.delete(key); this.committed.delete(key); this.failures.delete(key);
        }
      }
    }
  }
  async acquireLease(id: string, owner: string) {
    try { return await this.request<{ ok: boolean; previousOwner: string | null }>(`/lease/${id}`, "PUT", { owner }); }
    catch (error) { if (error instanceof StorageError && error.kind === "conflict") return null; throw error; }
  }
  async lease(id: string, owner: string, operation: "acquire" | "renew" | "release" = "acquire") {
    try {
      await this.request(`/lease/${id}${operation === "release" ? `/${owner}` : ""}`, operation === "release" ? "DELETE" : "PUT", operation === "release" ? undefined : { owner, renew: operation === "renew" });
      return true;
    } catch (error) { if (error instanceof StorageError && error.kind === "conflict") return false; throw error; }
  }
  private values<T>(kind: RecordRow["kind"]): T[] { return [...this.committed.values()].filter((row) => row.kind === kind).map((row) => structuredClone(row.data) as T); }
  private enqueue(id: string, write: () => Promise<void>) {
    const task = (this.pending.get(id) ?? Promise.resolve()).then(async () => {
      if (this.failures.has(id)) return;
      try { await write(); }
      catch (error) {
        this.failures.set(id, error as Error);
        const old = this.committed.get(id);
        if (old) this.records.set(id, structuredClone(old)); else this.records.delete(id);
      }
    });
    this.pending.set(id, task);
  }
  private save(kind: RecordRow["kind"], data: RecordRow["data"], leaseOwner?: string) {
    if (this.failures.has(data.id)) throw this.failures.get(data.id);
    const organizationId = data.organizationId;
    if (!organizationId) throw new Error("必须先选择组织");
    const previous = this.records.get(data.id);
    const row: RecordRow = { id: data.id, organizationId, kind, version: (this.versions.get(data) ?? previous?.version ?? 0) + 1, data: structuredClone(data) };
    this.records.set(data.id, row);
    this.enqueue(data.id, async () => {
      // A stable write ID reconciles a committed write whose HTTP acknowledgment was lost.
      const payload = { ...row, id: undefined, version: row.version - 1, writeId: randomUUID(), leaseOwner };
      for (let attempt = 0; ; attempt++) {
        try { const result = await this.request<{ version: number }>(`/${data.id}`, "PUT", payload); if (result.version !== row.version) throw new StorageError("conflict", 409); break; }
        catch (error) { if (!(error instanceof StorageError) || !["network", "storage"].includes(error.kind) || error.status < 500 || attempt >= 2) throw error; }
      }
      this.committed.set(row.id, structuredClone(row));
    });
  }
  private remove(id: string) {
    if (this.failures.has(id)) throw this.failures.get(id);
    const previous = this.records.get(id);
    if (!previous) return;
    this.records.delete(id);
    this.enqueue(id, async () => { await this.request(`/${id}/${previous.version}`, "DELETE"); this.committed.delete(id); });
  }
  async flush(id?: string) {
    if (id) { await this.pending.get(id); if (this.failures.has(id)) throw this.failures.get(id); }
    else { await Promise.all(this.pending.values()); const error = this.failures.values().next().value; if (error) throw error; }
  }
  listRooms() { return this.values<RoomRecord>("room").sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  getRoom(id: string) { return this.readRecord<RoomRecord>(id, "room"); }
  getCommittedRoom(id: string) { return this.readRecord<RoomRecord>(id, "room", this.committed); }
  private readRecord<T>(id: string, kind: RecordRow["kind"], records = this.records): T | undefined {
    if (records === this.records && this.failures.has(id)) throw this.failures.get(id);
    const row = records.get(id);
    if (row?.kind !== kind) return undefined;
    const data = structuredClone(row.data);
    this.versions.set(data, row.version);
    return data as T;
  }
  saveRoom(room: RoomRecord, leaseOwner?: string) { this.save("room", room, leaseOwner); }
  listAgents() { return this.values<AgentEntity>("agent"); }
  getAgent(id: string) { return this.readRecord<AgentEntity>(id, "agent"); }
  saveAgent(agent: AgentEntity) { this.save("agent", agent); }
  deleteAgent(id: string) { this.remove(id); }
  listProviders(): ProviderConnection[] { return this.values<Provider>("provider").map(({ apiKey: _key, ...provider }) => provider); }
  deleteProvider(id: string) { this.remove(id); }
  getProvider(id: string) { return this.readRecord<Provider>(id, "provider"); }
  saveProvider(input: Omit<ProviderConnection, "id" | "configured"> & { apiKey?: string; organizationId?: string }, id: string = randomUUID()) {
    const previous = this.getProvider(id);
    const apiKey = input.apiKey || previous?.apiKey || "";
    const provider: Provider = { ...input, id, apiKey, configured: Boolean(apiKey), organizationId: input.organizationId || previous?.organizationId || "" };
    this.save("provider", provider);
    const { apiKey: _key, ...publicProvider } = provider;
    return publicProvider;
  }
  close() {}
}
