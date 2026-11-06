import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSpeechError } from "../src/domain/conversation";
import { availableAgents, systemAgents } from "../server/agent-catalog";
import { applyAction, createGame, getDecision } from "../src/domain/engine";
import { DEFAULT_OPTIONS, type AgentEntity, type Participant, type StoredAgent } from "../src/domain/types";

test("only five enabled characters are listed; all old and disabled identities stay hidden", () => {
  const personal: AgentEntity = { id: "personal", source: "personal", ownerId: "owner", name: "伙伴", instructions: "", description: "", color: "#123456", version: 1, createdAt: "" };
  const records: StoredAgent[] = [personal, { ...personal, id: "disabled", enabled: false }, { ...personal, id: "active", enabled: true }, { ...personal, id: "other", ownerId: "other", enabled: true }, { id: "legacy", providerId: "p", vendor: "Vendor", modelName: "Old Model", modelId: "m", color: "#123456", createdAt: "" }];
  const catalog = availableAgents(records, "owner");
  assert.deepEqual(catalog.map((agent) => agent.name), ["林小满", "陈序", "许棠", "周野", "大肥鱼", "伙伴"]);
  assert.equal(catalog.at(-1)?.id, "active");
  assert.ok(catalog.every((agent) => agent.enabled === true));
  const retired = systemAgents().filter((agent) => !agent.enabled);
  assert.deepEqual(retired.map((agent) => agent.id), ["system-analyst", "system-explorer", "system-critic", "system-synthesizer"]);
  assert.ok(catalog.slice(0, 5).every((agent) => agent.background && agent.traits?.length === 3 && agent.portrait && agent.instructions.includes(agent.name)));
  const fish = catalog.find((agent) => agent.name === "大肥鱼")!;
  assert.match(fish.instructions, /鲸鱼娘/); assert.match(fish.instructions, /白饭/); assert.match(fish.instructions, /模型切换/);
});

test("conversation validation accepts short speech and rejects reports without truncating them", () => {
  for (const text of ["我觉得可以先试一小步，看看有没有人真的愿意付钱。", "是鲸啦，不过你说的成本问题确实得算进去。", "我想先听听你的顾虑。你最担心什么？", "短句就好。", "你会选A（便宜一些）还是B？"]) assert.equal(agentSpeechError(text), undefined, text);
  for (const text of ["", "   ", "# 分析", "结论：先验证市场。", "综上所述，应该先调查。", "1. 先验证市场", "一、看看需求", "**我的分析**", "|选择|原因|", "```text```", "先看需求。\n再看成本。", "先看需求。\u2028再看成本。", "（甩甩尾巴）先看需求。", "字".repeat(101), "想试试。先算钱。看看需求。再做决定。"]) assert.ok(agentSpeechError(text), text);
});

const participants: Participant[] = [1, 2].map((seat) => ({ id: `p${seat}`, agentId: `a${seat}`, modelId: "", providerId: "", vendor: "Agent", modelName: `伙伴${seat}`, color: "#123456", seat }));

test("AI report-style actions are rejected before persistence while human messages keep their formatting", () => {
  const state = createGame("debate", participants, DEFAULT_OPTIONS, "想试试创业");
  const decision = getDecision(state, "p1")!;
  assert.match(decision.prompt, /默认一句完整口语/);
  const speech = decision.tools.find((tool) => tool.name === "send_group_message")!;
  assert.equal((speech.inputSchema.properties as Record<string, { maxLength: number }>).content.maxLength, 100);
  assert.throws(() => applyAction(state, "p1", "send_group_message", { channelId: "public", content: "结论：先做市场调查。" }, "bad", state.phaseVersion), /报告/);
  assert.equal(state.events.some((event) => event.type === "message"), false);
  const accepted = applyAction(state, "p1", "send_group_message", { channelId: "public", content: "我觉得可以先问问身边有没有人真愿意买。" }, "good", state.phaseVersion).state;
  assert.equal(accepted.events.filter((event) => event.type === "message").length, 1);
  const human = createGame("debate", participants.map((p) => ({ ...p, kind: "human" as const, userId: p.id })), DEFAULT_OPTIONS, "测试");
  const input = { channelId: "public", content: "# 我的想法\n\n1. 先问问需求" };
  assert.doesNotThrow(() => applyAction(human, "p1", "send_group_message", input, "human", human.phaseVersion));
});
