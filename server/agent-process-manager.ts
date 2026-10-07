import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Participant, ToolSpec } from "../src/domain/types";

export type AgentExecutionErrorCode = "timeout" | "authentication" | "rate_limit" | "invalid_request" | "insufficient_credits" | "model_unavailable" | "service_unavailable" | "provider" | "missing_action" | "cancelled" | "process_exit";
const ERROR_MESSAGES: Record<AgentExecutionErrorCode, string> = {
  timeout: "Agent 响应超时，已确认的行动已保留，请稍后继续",
  authentication: "模型连接认证失败，请检查 API Key 和模型访问权限",
  rate_limit: "模型服务请求过于频繁，请稍后继续",
  invalid_request: "模型服务拒绝了请求参数或工具格式",
  insufficient_credits: "模型服务余额不足",
  model_unavailable: "模型不可用或 Model ID 不存在",
  service_unavailable: "模型服务暂时不可用",
  provider: "Agent 执行失败，请检查模型服务状态与工具调用支持",
  missing_action: "Agent 未提交本轮所需行动，请重试",
  cancelled: "Agent 行动已取消",
  process_exit: "Agent 独立进程意外退出，已确认的行动已保留",
};

/** Only safe, fixed messages leave the process boundary; no provider text or cause. */
export class AgentExecutionError extends Error {
  constructor(readonly code: AgentExecutionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = code === "cancelled" ? "AbortError" : "AgentExecutionError";
  }
}

export function resolveAgentTimeoutMs(value: string | undefined = process.env.HUB_AGENT_TIMEOUT_MS): number {
  const parsed = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.min(300_000, Math.max(10_000, Math.floor(parsed))) : 180_000;
}

export interface AgentRunInput {
  roomId: string;
  participant: Participant;
  provider: { kind: "openrouter" | "openai-compatible"; baseUrl: string; apiKey: string };
  executionMode: "live" | "demo";
  phaseVersion: number;
  prompt: string;
  tools: ToolSpec[];
  requiredTool: string;
  onAction: (name: string, args: Record<string, unknown>, actionId: string) => Promise<unknown>;
  signal?: AbortSignal;
}

export interface WorkerRun extends Omit<AgentRunInput, "onAction" | "signal"> {
  type: "run";
  requestId: string;
  sessionDirectory: string;
}
export type WorkerCommand = WorkerRun
  | { type: "cancel"; requestId: string }
  | { type: "shutdown" }
  | { type: "action_result"; requestId: string; actionId: string; ok: boolean; result?: unknown };
export type WorkerEvent =
  | { type: "action"; requestId: string; actionId: string; name: string; args: Record<string, unknown> }
  | { type: "done"; requestId: string }
  | { type: "failed"; requestId: string; code: AgentExecutionErrorCode };
type Status = { pid?: number; state: "idle" | "thinking" | "error" };
type ActiveRun = {
  input: AgentRunInput;
  requestId: string;
  requiredAcknowledged: boolean;
  actions: Map<string, Promise<{ ok: boolean; result?: unknown }>>;
  finish: (error?: Error) => void;
};
type AgentProcess = {
  roomId: string;
  participantId: string;
  child: ChildProcess;
  exited: Promise<void>;
  active?: ActiveRun;
  closing?: Promise<void>;
};

const abortError = () => new AgentExecutionError("cancelled");

/** Orchestration only: every seat runs the unmodified 42-agent core in its own OS process. */
export class AgentProcessManager {
  private readonly processes = new Map<string, AgentProcess>();
  private readonly timeoutMs = resolveAgentTimeoutMs();
  private closed = false;
  private readonly onExit = () => {
    for (const entry of this.processes.values()) entry.child.kill("SIGKILL");
  };

  constructor(private readonly options: { dataDir: string; onStatus?: (roomId: string, participantId: string, status: Status) => void }) {
    process.once("exit", this.onExit);
  }

  getPid(roomId: string, participantId: string): number | undefined {
    return this.processes.get(this.key(roomId, participantId))?.child.pid;
  }

  async run(input: AgentRunInput): Promise<void> {
    if (this.closed) throw new Error("Agent 进程管理器已关闭");
    if (input.signal?.aborted) throw abortError();
    if (!input.tools.some((tool) => tool.name === input.requiredTool)) throw new Error("本轮必需工具未授权");
    const entry = this.getOrSpawn(input.roomId, input.participant.id);
    if (entry.active || entry.closing) throw new Error("该 Agent 已有运行中的行动");
    const requestId = randomUUID();
    await new Promise<void>((resolveRun, rejectRun) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", cancel);
        entry.active = undefined;
        this.status(entry, error && error.name !== "AbortError" ? "error" : "idle");
        if (error) rejectRun(error); else resolveRun();
      };
      const cancel = () => {
        finish(abortError());
        void this.stop(entry);
      };
      const timer = setTimeout(() => {
        finish(new AgentExecutionError("timeout"));
        void this.stop(entry);
      }, this.timeoutMs);
      entry.active = { input, requestId, requiredAcknowledged: false, actions: new Map(), finish };
      input.signal?.addEventListener("abort", cancel, { once: true });
      if (input.signal?.aborted) { cancel(); return; }
      this.status(entry, "thinking");
      this.send(entry, {
        type: "run", requestId, roomId: input.roomId, participant: input.participant,
        provider: input.provider, executionMode: input.executionMode, phaseVersion: input.phaseVersion,
        prompt: input.prompt, tools: input.tools, requiredTool: input.requiredTool,
        sessionDirectory: join(resolve(this.options.dataDir), "agents", this.key(input.roomId, input.participant.id)),
      });
    });
  }

  async cancelRoom(roomId: string): Promise<void> {
    await this.closeRoom(roomId);
  }

  async closeRoom(roomId: string): Promise<void> {
    await Promise.all([...this.processes.values()].filter((entry) => entry.roomId === roomId).map((entry) => this.stop(entry)));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.processes.values()].map((entry) => this.stop(entry)));
    process.removeListener("exit", this.onExit);
  }

  private key(roomId: string, participantId: string) {
    return createHash("sha256").update(JSON.stringify([roomId, participantId])).digest("hex");
  }

  private status(entry: AgentProcess, state: Status["state"]) {
    try { this.options.onStatus?.(entry.roomId, entry.participantId, { pid: entry.closing ? undefined : entry.child.pid, state }); }
    catch { /* Observers cannot interrupt process cleanup or canonical actions. */ }
  }

  private getOrSpawn(roomId: string, participantId: string): AgentProcess {
    const key = this.key(roomId, participantId);
    const existing = this.processes.get(key);
    if (existing) return existing;
    // Never inherit other providers' credentials or the coordinator's auth token.
    const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
    for (const name of ["PATH", "NODE_ENV", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "SystemRoot"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const cloud = process.env.HUB_EXECUTION === "workflow" || Boolean(process.env.VERCEL);
    const child = fork(cloud ? resolve(process.cwd(), ".runtime/agent-worker.mjs") : fileURLToPath(new URL("./agent-worker.ts", import.meta.url)), [], {
      execArgv: cloud ? [] : ["--import", "tsx"], env, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    });
    let markExited!: () => void;
    const exited = new Promise<void>((done) => { markExited = done; });
    const entry: AgentProcess = { roomId, participantId, child, exited };
    this.processes.set(key, entry);
    child.on("message", (message: WorkerEvent) => { void this.receive(entry, message); });
    child.once("error", () => {
      entry.active?.finish(new AgentExecutionError("process_exit"));
      void this.stop(entry);
    });
    child.once("close", () => {
      if (this.processes.get(key) === entry) this.processes.delete(key);
      entry.active?.finish(new AgentExecutionError("process_exit"));
      markExited();
    });
    return entry;
  }

  private send(entry: AgentProcess, message: WorkerCommand) {
    if (!entry.child.connected) { entry.active?.finish(new AgentExecutionError("process_exit")); return; }
    try {
      entry.child.send(message, (error) => { if (error) { entry.active?.finish(new AgentExecutionError("process_exit")); void this.stop(entry); } });
    } catch { entry.active?.finish(new AgentExecutionError("process_exit")); void this.stop(entry); }
  }

  private async receive(entry: AgentProcess, message: WorkerEvent) {
    const active = entry.active;
    if (!active || !message || message.requestId !== active.requestId) return;
    if (message.type === "done") {
      active.finish(active.requiredAcknowledged ? undefined : new AgentExecutionError("missing_action"));
      return;
    }
    if (message.type === "failed") {
      active.finish(new AgentExecutionError(Object.hasOwn(ERROR_MESSAGES, message.code) ? message.code : "provider"));
      return;
    }
    if (message.type !== "action" || entry.closing || active.input.signal?.aborted) return;
    if (!active.input.tools.some((tool) => tool.name === message.name)) {
      this.send(entry, { type: "action_result", requestId: active.requestId, actionId: message.actionId, ok: false });
      return;
    }
    let action = active.actions.get(message.actionId);
    if (!action) {
      action = Promise.resolve().then(async () => {
        if (entry.active !== active || active.input.signal?.aborted || entry.closing) return { ok: false };
        try {
          const result = await active.input.onAction(message.name, message.args, message.actionId);
          const explicit = result !== null && typeof result === "object" ? (result as { turnComplete?: unknown }).turnComplete : undefined;
          if (explicit === true || (explicit === undefined && message.name === active.input.requiredTool)) active.requiredAcknowledged = true;
          return { ok: true, result };
        } catch { return { ok: false }; }
      });
      active.actions.set(message.actionId, action);
    }
    const result = await action;
    if (entry.active === active && !entry.closing) this.send(entry, { type: "action_result", requestId: active.requestId, actionId: message.actionId, ...result });
  }

  private stop(entry: AgentProcess): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.closing = Promise.resolve().then(async () => {
      const active = entry.active;
      if (active) this.send(entry, { type: "cancel", requestId: active.requestId });
      active?.finish(abortError());
      this.send(entry, { type: "shutdown" });
      const term = setTimeout(() => entry.child.kill("SIGTERM"), 600);
      const kill = setTimeout(() => entry.child.kill("SIGKILL"), 1_200);
      try { await entry.exited; }
      finally { clearTimeout(term); clearTimeout(kill); this.status(entry, "idle"); }
    });
    return entry.closing;
  }
}
