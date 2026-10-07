import { z } from "zod";
import { DEFAULT_OPTIONS } from "./types";

const text = (max: number) => z.string().trim().min(1, "不能为空").max(max);
export const providerSchema = z.object({
  name: text(80),
  kind: z.enum(["openrouter", "openai-compatible"]),
  baseUrl: z.string().trim().url().refine((url) => {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  }, "请使用不带凭据或查询参数的 HTTP / HTTPS API 地址"),
  apiKey: z.string().trim().max(4096).optional(),
}).strict();

export const agentSchema = z.object({
  providerId: text(100),
  vendor: text(80),
  modelId: text(160),
  modelName: text(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).strict();

export const roomSchema = z.object({
  title: text(100),
  topic: z.string().trim().max(1500).default(""),
  mode: z.enum(["debate", "undercover", "werewolf"]),
  agentIds: z.array(text(100)).min(1).max(12),
  joinAsParticipant: z.boolean().default(false),
  executionMode: z.enum(["demo", "live"]),
  options: z.object({
    rounds: z.number().int().min(1).max(10).default(DEFAULT_OPTIONS.rounds),
    allowPrivateMessages: z.boolean().default(DEFAULT_OPTIONS.allowPrivateMessages),
    undercoverCount: z.number().int().min(1).max(4).default(DEFAULT_OPTIONS.undercoverCount),
    civilianWord: text(40).default(DEFAULT_OPTIONS.civilianWord),
    undercoverWord: text(40).default(DEFAULT_OPTIONS.undercoverWord),
    werewolfCount: z.number().int().min(1).max(4).default(DEFAULT_OPTIONS.werewolfCount),
    hasSeer: z.boolean().default(DEFAULT_OPTIONS.hasSeer),
    hasWitch: z.boolean().default(DEFAULT_OPTIONS.hasWitch),
    hasHunter: z.boolean().default(DEFAULT_OPTIONS.hasHunter),
    hasGuard: z.boolean().default(DEFAULT_OPTIONS.hasGuard),
    hasBomber: z.boolean().default(DEFAULT_OPTIONS.hasBomber),
    hasWolfKing: z.boolean().default(DEFAULT_OPTIONS.hasWolfKing),
    maxRounds: z.number().int().min(2).max(20).default(DEFAULT_OPTIONS.maxRounds),
    revealRolesAtStart: z.boolean().default(DEFAULT_OPTIONS.revealRolesAtStart),
  }).strict().default(DEFAULT_OPTIONS),
}).strict().superRefine((input, ctx) => {
  const count = input.agentIds.length + Number(input.joinAsParticipant);
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (count < 2 || count > 12) issue("圆桌需要 2 至 12 个席位");
  if (input.mode === "debate" && !input.topic) issue("请填写本场辩论的话题");
  if (input.mode === "undercover") {
    if (count < 3) issue("谁是卧底至少需要 3 个席位");
    if (input.options.undercoverCount >= count / 2) issue("卧底人数必须少于其他玩家");
    if (input.options.civilianWord === input.options.undercoverWord) issue("两个词语不能相同");
  }
  if (input.mode === "werewolf") {
    if (count < 6) issue("狼人杀至少需要 6 个席位");
    if (input.options.werewolfCount >= count / 2) issue("狼人数必须少于好人人数");
    if (input.options.werewolfCount + Number(input.options.hasSeer) + Number(input.options.hasWitch) + Number(input.options.hasHunter) + Number(input.options.hasGuard) + Number(input.options.hasBomber) >= count) issue("请至少保留一位村民");
  }
});

export const controlSchema = z.object({ action: z.enum(["start", "pause", "resume", "stop"]), generation: z.number().int().nonnegative().optional() }).strict();
export const messageSchema = z.object({ content: text(2000) }).strict();
export const participantActionSchema = z.object({
  toolName: text(80), args: z.record(z.string(), z.unknown()),
  actionId: z.string().uuid(), phaseVersion: z.number().int().positive(),
}).strict();
