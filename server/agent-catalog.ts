import type { AgentEntity, StoredAgent } from "../src/domain/types";

// Shared definitions: registering users never writes copies or association rows.
const definitions = [
  ["analyst", "理性分析者", "梳理事实、依据和逻辑。", "先厘清事实和判断标准，区分证据与推测，用清晰的逻辑解释判断。", "#77977b"],
  ["explorer", "创意探索者", "探索不同角度和新的可能。", "积极探索不同角度和新想法，用具体例子提出有价值的可能，同时尊重已有事实。", "#bf8a71"],
  ["critic", "批判审视者", "检查假设、反例和潜在问题。", "检查隐含假设，寻找反例和潜在问题。质疑观点而非攻击参与者，并说明如何改进。", "#8294b5"],
  ["synthesizer", "综合归纳者", "比较分歧，汇总观点并形成结论。", "认真比较各方观点，归纳共识和分歧，在信息允许时给出有依据的综合判断。", "#b29ab3"],
] as const;

export function systemAgents(): AgentEntity[] {
  return definitions.map(([id, name, description, instructions, color]) => ({
    id: `system-${id}`, source: "system", name, description, instructions, color,
    version: 1, createdAt: "2026-11-05T00:00:00.000Z",
  }));
}

export function isPersonalAgent(agent: StoredAgent): agent is AgentEntity {
  return "source" in agent && agent.source === "personal" && Boolean(agent.ownerId);
}

export function availableAgents(stored: StoredAgent[], userId?: string): AgentEntity[] {
  return [...systemAgents(), ...stored.filter((agent): agent is AgentEntity => isPersonalAgent(agent) && agent.ownerId === userId)];
}
