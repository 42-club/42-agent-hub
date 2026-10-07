import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, readFileSync, closeSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { ZodError } from "zod";
import { SharedHubStore, StorageError } from "./shared-store";
import { HubStore, type RoomRecord } from "./store";
import { canIdentifyFailedParticipant, displayRoomError, participantFailureLabel } from "./room-errors";
import { AgentProcessManager } from "./agent-process-manager";
import { getModelCatalog } from "./model-catalog";
import { advanceGame, applyAction, createGame, getDecision, getPendingParticipantIds, projectGame, projectSelf } from "../src/domain/engine";
import { agentSchema, controlSchema, participantActionSchema, providerSchema, roomSchema } from "../src/domain/validation";
import type { AgentEntity, Participant, RoomSummary, RoomView } from "../src/domain/types";


export async function createCoordinator(options: { token: string; dataDir: string; cloud?: boolean; store?: SharedHubStore | HubStore; manager?: Pick<AgentProcessManager, "run" | "closeRoom" | "cancelRoom" | "close"> }) {
const token = options.token;
if (!token || token.length < 32) throw new Error("请通过 npm run dev 或 npm start 启动完整应用");
const dataDir = resolve(options.dataDir);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lockPath = join(dataDir, "coordinator.lock");
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = openSync(lockPath, "wx", 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(readFileSync(lockPath, "utf8"));
      try { if (!Number.isInteger(owner) || owner < 1) throw new Error("无法确认数据目录的运行进程"); process.kill(owner, 0); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(lockPath); continue; } throw probe; }
      throw new Error(`房间服务已在运行（PID ${owner}）。请先在原终端按 Ctrl+C 关闭旧的 Hub，再重新启动；不要删除正在使用的锁文件。`);
    }
  }
  throw new Error("无法取得房间服务独占锁");
}
if (!options.cloud) acquireLock();
if (process.env.HUB_STORAGE === "local-test" && process.env.NODE_ENV === "production") throw new Error("生产环境必须使用共享后端存储");
const store = options.store ?? (process.env.HUB_STORAGE === "local-test" ? new HubStore(dataDir) : await new SharedHubStore().initialize());
const running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
const runtimeStatus = new Map<string, { pid?: number; state: "idle" | "thinking" | "error" }>();
const manager = options.manager ?? new AgentProcessManager({ dataDir, onStatus(roomId, participantId, status) { runtimeStatus.set(`${roomId}:${participantId}`, status); } });

// Startup is read-only. Execution recovery happens only after acquiring an expired lease.
const locks = new Map<string, Promise<void>>();
async function lockRoom(id: string) {
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((done) => { release = done; });
  locks.set(id, next);
  await previous;
  return () => { release(); if (locks.get(id) === next) locks.delete(id); };
}
async function refresh(id: string) { if (store instanceof SharedHubStore) await store.refresh(id); }
async function changeRoom<T>(id: string, change: (room: RoomRecord) => T, owner?: string) {
  const unlock = await lockRoom(id);
  try {
    for (let attempt = 0; ; attempt++) {
      await refresh(id);
      const room = requireRoom(id);
      const result = change(room);
      try { await touch(room, owner); return result; }
      catch (error) { if (!(error instanceof StorageError) || error.kind !== "conflict" || attempt >= 3) throw error; }
    }
  } finally { unlock(); }
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function requireRoom(id: string) { const room = store.getRoom(id); if (!room) throw new HttpError(404, "房间不存在"); return room; }
async function touch(room: RoomRecord, owner?: string) {
  const previous = store.getRoom(room.id);
  // Private actions must not leak their count/timing via SSE's public updatedAt.
  if (!previous || previous.status !== room.status || previous.error !== room.error || JSON.stringify(projectGame(previous.game)) !== JSON.stringify(projectGame(room.game))) room.updatedAt = new Date().toISOString();
  else room.updatedAt = previous.updatedAt;
  if (store instanceof SharedHubStore) store.saveRoom(room, owner); else store.saveRoom(room);
  await store.flush(room.id);
}
function summary(room: RoomRecord): RoomSummary {
  const projection = projectGame(room.game);
  return { id: room.id, title: room.input.title, topic: room.input.topic, mode: room.input.mode, status: room.status, executionMode: room.input.executionMode,
    participantCount: projection.participants.length, modelNames: projection.participants.map((p) => p.modelName), round: projection.round, phaseLabel: projection.phaseLabel, createdAt: room.createdAt, updatedAt: room.updatedAt };
}
function view(room: RoomRecord, userId?: string): RoomView {
  const ownSeat = room.game.participants.find((p) => p.kind === "human" && p.userId === userId);
  // Games with human players do not expose spectator secrets to other accounts either.
  const hasHumans = room.game.participants.some((p) => p.kind === "human");
  const game = hasHumans ? { ...room.game, options: { ...room.game.options, revealRolesAtStart: false } } : room.game;
  const projection = projectGame(game);
  if (hasHumans) projection.events = projection.events.filter((event) => event.visibility === "public");
  const { civilianWord: _civilianWord, undercoverWord: _undercoverWord, ...options } = room.input.options;
  return { ...summary(room), executionGeneration: room.executionGeneration ?? 0, ...projection, privateMessages: ownSeat ? room.game.events.filter((event) => ["private", "wolves"].includes(event.visibility) && event.recipientIds.includes(ownSeat.id)) : [],
    ...(ownSeat ? { self: { ...(room.status === "waiting" ? { participantId: ownSeat.id, phaseVersion: 0 } : projectSelf(room.game, ownSeat.id)), tools: room.status === "running" ? projectSelf(room.game, ownSeat.id).tools : [] } } : {}),
    canControl: Boolean(userId && (!room.ownerId || room.ownerId === userId)), options, error: displayRoomError(room),
    participants: projection.participants.map((participant) => {
      if (room.status !== "running") return { ...participant, status: !participant.alive ? "eliminated" : room.status === "completed" ? "done" : "idle" };
      // Public process/activity metadata is available for debate only. Night actors are secret.
      if (room.input.mode !== "debate") return participant;
      const processState = runtimeStatus.get(`${room.id}:${participant.id}`);
      return { ...participant, pid: processState?.pid, status: processState?.state === "thinking" ? "thinking" : participant.status };
    }),
  };
}

const delay = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((done, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const finish = () => { signal?.removeEventListener("abort", cancel); done(); };
  const timer = setTimeout(finish, milliseconds);
  const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason); };
  signal?.addEventListener("abort", cancel, { once: true });
});

async function runRoom(id: string, signal: AbortSignal, expectedGeneration: number, recoveryOnly = false) {
  const owner = randomUUID();
  const shared = store instanceof SharedHubStore ? store : undefined;
  let previousOwner: string | null = null;
  if (shared) {
    let claim;
    while (!(claim = await shared.acquireLease(id, owner))) {
      if (options.cloud || recoveryOnly || signal.aborted) return;
      await delay(1000, signal);
      const row = await shared.request<{ data: RoomRecord } | null>(`/${id}`);
      if (!row || row.data.status !== "running" || (row.data.executionGeneration ?? 0) !== expectedGeneration) return;
    }
    previousOwner = claim.previousOwner;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let watch: Promise<void> | undefined;
  const valid = (room: RoomRecord) => {
    if (controller.signal.aborted || room.status !== "running" || (room.executionGeneration ?? 0) !== expectedGeneration) throw new DOMException("Execution superseded", "AbortError");
  };
  const commit = <T>(change: (room: RoomRecord) => T) => changeRoom(id, (room) => { valid(room); return change(room); }, shared ? owner : undefined);
  const monitor = async () => {
    try {
      if (shared) {
        if (!await shared.lease(id, owner, "renew")) { abort(); return; }
        const row = await shared.request<{ data: RoomRecord } | null>(`/${id}`);
        if (!row) { abort(); return; }
        valid(row.data);
      }
    } catch { abort(); }
    if (!controller.signal.aborted) heartbeat = setTimeout(() => { watch = monitor(); }, 1000);
  };
  if (shared) heartbeat = setTimeout(() => { watch = monitor(); }, 1000);
  try {
    while (!controller.signal.aborted) {
      const unlock = await lockRoom(id);
      let room: RoomRecord;
      try { await refresh(id); room = requireRoom(id); valid(room); } finally { unlock(); }
      if (recoveryOnly && !room.cloudAttempt) return;
      if (room.game.finished) { await commit((current) => { current.status = "completed"; }); return; }
      const ids = getPendingParticipantIds(room.game);
      if (room.cloudAttempt) {
        // A persisted owner implies a lease was acquired before dispatch. An old-format
        // attempt has no provable ownership; leave it for an explicit owner control.
        if (!shared || !room.cloudAttempt.owner || room.cloudAttempt.owner !== previousOwner || room.cloudAttempt.generation !== expectedGeneration) return false;
        await commit((current) => {
          current.status = "paused";
          current.executionGeneration = expectedGeneration + 1;
          current.error = "上次执行租约已过期，已保存确认的行动。请点击继续重试未完成席位。";
          delete current.cloudAttempt;
        });
        return;
      }
      const agentIds = ids.filter((seat) => room.game.participants.find((p) => p.id === seat)?.kind !== "human");
      if (!ids.length) {
        await commit((current) => { current.game = advanceGame(current.game); if (current.game.finished) current.status = "completed"; });
      } else if (!agentIds.length) {
        if (options.cloud) return;
        await delay(350, controller.signal); continue;
      } else {
        const snapshot = room;
        const jobs = agentIds.map((participantId) => {
          const participant = projectGame(snapshot.game).participants.find((p) => p.id === participantId)!;
          const decision = getDecision(snapshot.game, participantId);
          const provider = store.getProvider(participant.providerId);
          if (!decision) throw new Error("缺少当前阶段的决策任务");
          if (snapshot.input.executionMode === "live" && !provider?.configured) throw new Error("模型连接尚未配置");
          return { participant, decision, provider };
        });
        await commit((current) => { current.cloudAttempt = { phaseVersion: snapshot.game.phaseVersion, participantIds: agentIds, owner, generation: expectedGeneration }; });
        const results = await Promise.allSettled(jobs.map(async ({ participant, decision, provider }) => {
          try {
            await manager.run({ roomId: id, participant, executionMode: snapshot.input.executionMode,
              provider: { kind: provider?.kind ?? "openrouter", baseUrl: provider?.baseUrl ?? "https://openrouter.ai/api/v1", apiKey: provider?.apiKey ?? "" },
              phaseVersion: snapshot.game.phaseVersion, prompt: decision.prompt, tools: decision.tools, requiredTool: decision.requiredTool, signal: controller.signal,
              onAction: async (name, args, actionId) => {
                try {
                  return await commit((latest) => {
                    if (latest.cloudAttempt?.owner !== owner || latest.game.phaseVersion !== snapshot.game.phaseVersion) throw new DOMException("Execution superseded", "AbortError");
                    const applied = applyAction(latest.game, participant.id, name, args, actionId, snapshot.game.phaseVersion);
                    latest.game = applied.state;
                    return applied.result;
                  });
                } catch (error) { abort(); throw error; }
              },
            });
          } catch (error) {
            // A durable action remains valid even if the model stream subsequently fails.
            const current = store.getCommittedRoom(id);
            if (current && (current.game.phaseVersion !== snapshot.game.phaseVersion || !getPendingParticipantIds(current.game).includes(participant.id))) return;
            throw error;
          }
        }));
        if (controller.signal.aborted) return;
        const failures = results.flatMap((result, index) => {
          if (result.status !== "rejected") return [];
          const labels: Record<string, string> = {
            timeout: "请求超时", authentication: "OpenRouter 认证失败", rate_limit: "服务商限流，请稍后重试",
            invalid_request: "上游拒绝请求参数或工具格式", insufficient_credits: "OpenRouter 余额不足",
            model_unavailable: "模型不可用或 Model ID 不存在", service_unavailable: "上游模型服务暂时不可用",
            missing_action: "没有提交所需工具行动", process_exit: "执行进程意外退出", provider: "上游模型请求失败（具体原因未返回）", cancelled: "请求已取消",
          };
          const code = typeof result.reason?.code === "string" ? result.reason.code : "provider";
          // Preserve hidden night roles while identifying seats in public phases and revealed-role games.
          const subject = canIdentifyFailedParticipant(snapshot) ? participantFailureLabel(jobs[index].participant) : "模型";
          return [`${subject}：${labels[code] ?? labels.provider}`];
        });
        await commit((current) => {
          delete current.cloudAttempt;
          if (failures.length) {
            current.status = "error";
            current.error = `${[...new Set(failures)].join("；")}。已确认的行动已保存，点击继续只重试未完成的席位。`;
          } else { current.game = advanceGame(current.game); if (current.game.finished) current.status = "completed"; }
        });
      }
      if (options.cloud) return;
      await delay(room.input.executionMode === "demo" ? 1000 : 100, controller.signal);
    }
  } catch (error) {
    // Never repair an uncertain write by replaying a model request or overwriting authority.
    if (!controller.signal.aborted && !(error instanceof StorageError) && !(error instanceof DOMException)) {
      await commit((room) => { room.status = "error"; room.error = "执行已中断，已确认的行动已保留。请检查配置后继续。"; }).catch(() => {});
    }
  } finally {
    abort(); clearTimeout(heartbeat); await watch;
    signal.removeEventListener("abort", abort);
    await manager.closeRoom(id);
    if (shared) await shared.lease(id, owner, "release").catch(() => {});
  }
}

async function launch(id: string, receipt?: [string, string]) {
  if (running.has(id)) throw new HttpError(409, "房间正在处理上一次操作，请稍后重试");
  if (running.size >= 3) throw new HttpError(409, "最多同时运行 3 个房间，请先暂停一个房间");
  const room = requireRoom(id);
  if (room.input.executionMode === "live") {
    for (const participant of projectGame(room.game).participants) if (participant.kind !== "human" && !store.getProvider(participant.providerId)?.configured) throw new HttpError(400, "请先为所有参与者配置模型连接的 API Key");
  }
  if (receipt) (room.requests ??= {})[receipt[0]] = receipt[1];
  room.status = "running";
  room.executionGeneration = (room.executionGeneration ?? 0) + 1;
  delete room.cloudAttempt;
  room.error = null;
  await touch(room);
  if (options.cloud) return;
  const controller = new AbortController();
  // Defer execution so the registry is installed before lifecycle cleanup can occur.
  const promise = Promise.resolve().then(() => runRoom(id, controller.signal, room.executionGeneration ?? 0)).then(() => {}).catch(() => {}).finally(() => running.delete(id));
  running.set(id, { controller, promise });
}

async function stopRoom(id: string, stop: boolean, receipt?: [string, string]) {
  const room = requireRoom(id);
  if (receipt) (room.requests ??= {})[receipt[0]] = receipt[1];
  room.executionGeneration = (room.executionGeneration ?? 0) + 1;
  delete room.cloudAttempt;
  room.status = stop ? "completed" : "paused";
  room.error = stop ? "房间已手动结束，本局未结算胜负。" : null;
  await touch(room);
  const active = running.get(id);
  active?.controller.abort(new DOMException("Room paused", "AbortError"));
  void manager.cancelRoom(id).catch(() => {});
}

async function sendJson(response: ServerResponse, value: unknown, status = 200) {

  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 64_000) throw new HttpError(413, "请求内容过长"); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "请求格式无效"); }
}

function streamRoom(request: IncomingMessage, response: ServerResponse, id: string, userId?: string) {
  requireRoom(id);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  let previous = "";
  let tick = 0;
  const publish = () => {
    if (response.destroyed) return;
    // Snapshot on reconnect is authoritative; lossy core token events are never used as a log.
    const committed = store.getCommittedRoom(id);
    if (!committed) return;
    const payload = JSON.stringify(view(committed, userId));
    if (payload !== previous) { previous = payload; response.write(`event: snapshot\ndata: ${payload}\n\n`); }
    else if (++tick % 15 === 0) response.write(": heartbeat\n\n");
    if (response.writableLength > 1_000_000) response.destroy();
  };
  publish();
  if (options.cloud) { response.end(); return; }
  const timer = setInterval(publish, 700);
  // Reconnect through the web proxy periodically so session and membership revocation are rechecked.
  const lease = setTimeout(() => response.end(), 30_000);
  response.on("close", () => { clearInterval(timer); clearTimeout(lease); });
}

const server = createServer(async (request, response) => {
  let unlock: (() => void) | undefined;
  try {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(401, "未授权");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method ?? "GET";
    if (url.pathname === "/health") { await sendJson(response, { ok: true }); return; }
    if (parts[0] !== "api") throw new HttpError(404, "接口不存在");
    const [, resource, id, action] = parts;
    // Only short request/state work is serialized, never model execution.
    unlock = await lockRoom(id ?? "catalog");
    if (store instanceof SharedHubStore) { if (id) await store.refresh(id); else await store.refresh(); }
    // These headers are supplied by the authenticated Next proxy; the coordinator is token-gated.
    const userId = typeof request.headers["x-hub-user-id"] === "string" ? request.headers["x-hub-user-id"] : undefined;
    const organizationId = typeof request.headers["x-hub-organization-id"] === "string" ? request.headers["x-hub-organization-id"] : undefined;
    const role = request.headers["x-hub-role"];
    const requestId = request.headers["idempotency-key"];
    if (requestId && (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId))) throw new HttpError(400, "请求 ID 无效");
    const receipt = requestId ? [`${userId}:${requestId}`, `${method}:${action}`] as [string, string] : undefined;
    if (store instanceof SharedHubStore && (!userId || !organizationId || !["owner", "admin", "member", "viewer"].includes(String(role)))) throw new HttpError(401, "请先登录并选择组织");
    if (!["GET", "HEAD"].includes(method) && role === "viewer") throw new HttpError(403, "当前成员为只读角色");
    const inOrganization = (item: { organizationId?: string }) => item.organizationId === organizationId;
    const userName = decodeURIComponent(String(request.headers["x-hub-user-name"] || "圆桌成员")).slice(0, 40);
    const humanSeat = (seat: number): Participant => {
      if (!userId) throw new HttpError(401, "请先登录 42 账号");
      return { id: randomUUID(), kind: "human", userId, agentId: "", providerId: "", vendor: "真人", modelId: "human", modelName: userName, color: "#dbe6cf", seat };
    };
    if (resource === "models" && method === "GET") {
      try { await sendJson(response, await getModelCatalog()); } catch { throw new HttpError(502, "暂时无法读取 OpenRouter 模型目录，你仍可手动填写 Model ID。"); }
      return;
    }
    if (resource === "dashboard" && method === "GET") { await sendJson(response, { agents: store.listAgents().filter(inOrganization), providers: store.listProviders().filter(inOrganization), rooms: store.listRooms().filter(inOrganization).map(summary) }); return; }

    if (resource === "providers") {
      if (organizationId && role !== "owner" && role !== "admin") throw new HttpError(403, "只有组织管理员可以配置连接");
      if (id && !inOrganization(store.getProvider(id) ?? {})) throw new HttpError(404, "连接不存在");
      if (method === "POST" || (method === "PUT" && id)) {
        const input = providerSchema.parse(await body(request));
        if (id && !store.getProvider(id)) throw new HttpError(404, "模型连接不存在");
        if (id && store.listRooms().some((room) => room.status === "running" && projectGame(room.game).participants.some((p) => p.providerId === id))) throw new HttpError(409, "请先暂停使用此连接的房间");
        const provider = store.saveProvider({ ...input, organizationId }, id ?? store.listProviders().find(inOrganization)?.id); await store.flush(provider.id); await sendJson(response, provider); return;
      }
      if (method === "DELETE" && id) {
        if (!store.getProvider(id)) throw new HttpError(404, "模型连接不存在");
        if (store.listAgents().some((agent) => agent.providerId === id)) throw new HttpError(409, "请先删除或调整使用此连接的 Agent");
        if (store.listRooms().some((room) => room.status !== "completed" && projectGame(room.game).participants.some((p) => p.providerId === id))) throw new HttpError(409, "还有未结束的房间使用此连接");
        store.deleteProvider(id); await store.flush(id); await sendJson(response, { ok: true }); return;
      }
    }
    if (resource === "agents") {
      if (id && !inOrganization(store.getAgent(id) ?? {})) throw new HttpError(404, "Agent 不存在");
      if (method === "POST" || (method === "PUT" && id)) {
        const input = agentSchema.parse(await body(request));
        if (!store.getProvider(input.providerId) || !inOrganization(store.getProvider(input.providerId)!)) throw new HttpError(400, "请选择已有的模型连接");
        const previous = id ? store.getAgent(id) : undefined;
        if (id && !previous) throw new HttpError(404, "Agent 不存在");
        const agent: AgentEntity = { ...input, organizationId, id: id ?? randomUUID(), color: input.color ?? previous?.color ?? "#77977b", createdAt: previous?.createdAt ?? new Date().toISOString() };
        store.saveAgent(agent); await store.flush(agent.id); await sendJson(response, agent); return;
      }
      if (method === "DELETE" && id) {
        if (!store.getAgent(id)) throw new HttpError(404, "Agent 不存在");
        store.deleteAgent(id); await store.flush(id); await sendJson(response, { ok: true }); return;
      }
    }
    if (resource === "rooms") {
      if (method === "POST" && !id) {
        const input = roomSchema.parse(await body(request));
        const participants: Participant[] = input.agentIds.map((agentId, index) => {
          const agent = store.getAgent(agentId); if (!agent || !inOrganization(agent)) throw new HttpError(400, "所选 Agent 已被删除，请重新选择");
          if (input.executionMode === "live" && !store.getProvider(agent.providerId)?.configured) throw new HttpError(400, "请先配置模型连接，或选择离线演示");
          return { id: randomUUID(), agentId, providerId: agent.providerId, vendor: agent.vendor, modelId: agent.modelId, modelName: agent.modelName, color: agent.color, seat: index + 1 };
        });
        if (input.joinAsParticipant) participants.push(humanSeat(participants.length + 1));
        // A human could otherwise switch to spectator mode to discover secret identities.
        if (participants.some((p) => p.kind === "human")) input.options.revealRolesAtStart = false;
        const room: RoomRecord = { organizationId, ownerId: userId, id: randomUUID(), input, status: "waiting", game: createGame(input.mode, participants, input.options, input.topic, randomUUID()), error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        store.saveRoom(room); await store.flush(room.id); await sendJson(response, { id: room.id }, 201); return;
      }
      if (id) {
        const room = requireRoom(id);
        if (!inOrganization(room)) throw new HttpError(404, "房间不存在或你不属于该组织");
        if (method === "GET" && !action) { await sendJson(response, view(room, userId)); return; }
        if (method === "GET" && action === "events") { streamRoom(request, response, id, userId); return; }
        if (method === "GET" && action === "export") {
          response.setHeader("content-disposition", `attachment; filename="42-agent-room-${id}.json"`);
          await sendJson(response, { formatVersion: 1, exportedAt: new Date().toISOString(), room: view(room, userId) }); return;
        }
        if (method === "POST" && action === "control") {
          const control = controlSchema.parse(await body(request));
          const current = requireRoom(id);
          if (store instanceof SharedHubStore && (!receipt || control.generation === undefined)) throw new HttpError(400, "请刷新页面后使用带版本的幂等请求");
          if (current.ownerId && current.ownerId !== userId) throw new HttpError(403, "只有房主可以控制圆桌");
          if (receipt) {
            receipt[1] += `:${control.action}:${control.generation ?? ""}`;
            const existing = current.requests?.[receipt[0]];
            if (existing && existing !== receipt[1]) throw new HttpError(409, "请求 ID 已用于其他操作");
            if (existing) { await sendJson(response, view(current, userId)); return; }
          }
          if (control.generation !== undefined && control.generation !== (current.executionGeneration ?? 0)) throw new HttpError(409, "房间状态已变化，请刷新后重试");
          if (current.status === "completed") throw new HttpError(409, "房间已经结束");
          if (control.action === "start" || control.action === "resume") {
            if (current.status === "running") { await sendJson(response, view(current, userId)); return; }
            await launch(id, receipt);
          } else await stopRoom(id, control.action === "stop", receipt);
          await sendJson(response, view(requireRoom(id), userId)); return;
        }
        if ((method === "POST" || method === "DELETE") && action === "seat") {
          if (store instanceof SharedHubStore && !receipt) throw new HttpError(400, "请刷新页面后使用幂等请求");
          if (!userId) throw new HttpError(401, "请先登录 42 账号");
          if (receipt) {
            const existing = room.requests?.[receipt[0]];
            if (existing && existing !== receipt[1]) throw new HttpError(409, "请求 ID 已用于其他操作");
            if (existing) { await sendJson(response, view(room, userId)); return; }
            (room.requests ??= {})[receipt[0]] = receipt[1];
          }
          if (room.status !== "waiting") throw new HttpError(409, "请在开场前添加或移除席位");
          const own = room.game.participants.find((p) => p.userId === userId);
          let participants = room.game.participants;
          if (method === "POST") {
            if (own) { if (receipt) await touch(room); await sendJson(response, view(room, userId)); return; }
            if (participants.length >= 12) throw new HttpError(409, "圆桌席位已满（最多 12 位）");
            participants = [...participants, humanSeat(participants.length + 1)];
          } else {
            if (!own) { if (receipt) await touch(room); await sendJson(response, view(room, userId)); return; }
            participants = participants.filter((p) => p.id !== own.id).map((p, index) => ({ ...p, seat: index + 1 }));
          }
          const options = { ...room.input.options, ...(participants.some((p) => p.kind === "human") ? { revealRolesAtStart: false } : {}) };
          try { room.game = createGame(room.input.mode, participants, options, room.input.topic, room.game.seed); }
          catch { throw new HttpError(409, "移除席位后人数不满足本场角色规则"); }
          room.input.options = options;
          await touch(room); await sendJson(response, view(room, userId)); return;
        }
        if (method === "POST" && (action === "actions" || action === "messages")) {
          if (!userId) throw new HttpError(401, "请先登录 42 账号");
          const input = participantActionSchema.parse(await body(request));
          const latest = requireRoom(id);
          const participant = latest.game.participants.find((p) => p.kind === "human" && p.userId === userId);
          if (!participant) throw new HttpError(403, "请在开场前添加自己的席位");
          if (Object.hasOwn(latest.game.actions, input.actionId)) {
            try { applyAction(latest.game, participant.id, input.toolName, input.args, input.actionId, input.phaseVersion); }
            catch { throw new HttpError(409, "动作 ID 已用于其他请求"); }
            await sendJson(response, view(latest, userId)); return;
          }
          if (latest.status !== "running") throw new HttpError(409, "请等待圆桌开始或继续");
          try {
            latest.game = applyAction(latest.game, participant.id, input.toolName, input.args, input.actionId, input.phaseVersion).state;
          } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "当前不能行动"); }
          await touch(latest); await sendJson(response, view(latest, userId)); return;
        }
      }
    }
    throw new HttpError(404, "接口不存在");
  } catch (error) {
    if (response.headersSent) { response.end(); return; }
    if (error instanceof HttpError) await sendJson(response, { error: error.message }, error.status);
    else if (error instanceof StorageError) await sendJson(response, { error: error.message, code: error.kind }, error.kind === "conflict" ? 409 : error.kind === "permission" ? 403 : 503);
    else if (error instanceof ZodError) await sendJson(response, { error: error.issues[0]?.message ?? "请检查输入内容" }, 400);
    else await sendJson(response, { error: "操作未完成，请检查配置后重试。" }, 500);
  } finally { unlock?.(); }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

// A restart may reconcile only attempts whose recorded owner has demonstrably expired.
// No model request is dispatched here; unknown legacy attempts require explicit controls.
if (!options.cloud && store instanceof SharedHubStore) {
  const expired = await store.request<{ scope: string; owner: string }[]>("/leases/expired");
  for (const lease of expired) {
    const room = store.getRoom(lease.scope);
    if (room?.status === "running" && room.cloudAttempt?.owner === lease.owner) {
      await runRoom(room.id, new AbortController().signal, room.executionGeneration ?? 0, true).catch(() => {});
    }
  }
}

return {
  server,
  async tick(id: string, generation: number) {
    if (await runRoom(id, new AbortController().signal, generation) === false) return false;
    await refresh(id);
    const room = requireRoom(id);
    if (room.status !== "running" || (room.executionGeneration ?? 0) !== generation) return false;
    const pending=getPendingParticipantIds(room.game);
    return pending.length===0 || pending.some((id)=>room.game.participants.find((p)=>p.id===id)?.kind!=="human");
  },
  async close() {
    for(const active of running.values())active.controller.abort();
    await manager.close();
    await Promise.allSettled([...running.values()].map((a)=>a.promise));
    store.close();
    server.close();
    if (!options.cloud) { try { unlinkSync(lockPath); } catch {} }
  },
};
}
