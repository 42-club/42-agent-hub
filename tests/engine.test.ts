import { test } from "node:test";
import assert from "node:assert/strict";
import { addHostMessage, advanceGame, applyAction, createGame, deriveLegacyVoteHistory, getDecision, getPendingParticipantIds, projectGame, type GameState } from "../src/domain/engine";
import { DEFAULT_OPTIONS, type Participant, type RoomOptions } from "../src/domain/types";

const participants = (count: number): Participant[] => Array.from({ length: count }, (_, index) => ({ id: `p${index + 1}`, agentId: `a${index + 1}`, providerId: "provider", vendor: "test", modelId: "shared-model", modelName: "same display name", color: "#123456", seat: index + 1 }));
const game = (mode: GameState["mode"], count = 6, options: Partial<RoomOptions> = {}, seed = "test-seed") => createGame(mode, participants(count), { ...DEFAULT_OPTIONS, ...options }, "好问题比答案更重要吗", seed);
let actionNumber = 0;
function action(state: GameState, participant: string, name: string, args: Record<string, unknown> = {}) { return applyAction(state, participant, name, args, `action-${++actionNumber}`, state.phaseVersion).state; }
function actAll(state: GameState, decide: (state: GameState, id: string) => [string, Record<string, unknown>]): GameState { let next = state; while (getPendingParticipantIds(next).length) { const id = getPendingParticipantIds(next)[0]; const [name, args] = decide(next, id); next = action(next, id, name, args); } return next; }
function speakAll(state: GameState) { return actAll(state, (_, id) => ["send_group_message", { channelId: "public", content: `来自 ${id} 的本轮观点。` }]); }
const roleIds = (state: GameState, role: string) => state.participants.filter((p) => state.players[p.id].role === role).map((p) => p.id);

test("all public speeches follow seat order and hear earlier speakers without mutating inputs", () => {
  const initial = game("debate", 4, { rounds: 3 });
  const saved = structuredClone(initial);
  assert.equal(getDecision(initial, "p2"), null);
  assert.throws(() => action(initial, "p2", "send_group_message", { channelId: "public", content: "out of turn" }), /行动权限/);
  const one = action(initial, "p1", "send_group_message", { channelId: "public", content: "本轮前面的观点" });
  assert.deepEqual(initial, saved);
  assert.match(getDecision(one, "p2")!.prompt, /本轮前面的观点/);
  assert.equal(getDecision(one, "p1"), null);
  assert.deepEqual(getPendingParticipantIds(one), ["p2"]);
  assert.equal(advanceGame(one).phaseVersion, one.phaseVersion);
  assert.equal(projectGame(one).events.filter((event) => event.type === "message").length, 1);
  const next = advanceGame(speakAll(one));
  assert.equal(next.round, 2);
  assert.match(getDecision(next, "p1")!.prompt, /本轮前面的观点/);
});

test("strict tools reject invalid targets, undeclared params and stale permissions; retries are idempotent", () => {
  const start = game("debate", 2);
  const args = { channelId: "public", content: "第一条观点" };
  const first = applyAction(start, "p1", "send_group_message", args, "same-action", start.phaseVersion);
  const retry = applyAction(first.state, "p1", "send_group_message", args, "same-action", start.phaseVersion);
  assert.deepEqual(retry, first);
  assert.throws(() => applyAction(first.state, "p2", "send_group_message", args, "same-action", start.phaseVersion), /不同请求/);
  assert.throws(() => applyAction(first.state, "p1", "send_group_message", { ...args, content: "changed" }, "same-action", start.phaseVersion), /不同请求/);
  assert.throws(() => action(start, "p1", "vote", { targetId: "p2" }), /不允许/);
  assert.throws(() => action(start, "p1", "send_group_message", { ...args, injected: true }), /未声明/);
  assert.throws(() => action(start, "p1", "send_private_message", { recipientId: "missing", content: "bad" }), /范围/);
  assert.throws(() => action(start, "p1", "send_group_message", { channelId: "public", content: "   " }), /长度/);
  const next = advanceGame(speakAll(first.state));
  assert.throws(() => applyAction(next, "p2", "send_group_message", args, "late", start.phaseVersion), /过期/);
  const lateRetry = applyAction(next, "p1", "send_group_message", args, "same-action", start.phaseVersion);
  assert.deepEqual(lateRetry.state, next);
  assert.throws(() => action(next, "p1", "send_group_message", { channelId: "wolves", content: "秘密频道" }), /范围/);
});

test("private messages are visible only to sender and recipient and never leak via public event numbering", () => {
  const initial = game("debate", 4);
  const privateState = action(initial, "p1", "send_private_message", { recipientId: "p2", content: "PRIVATE_TOKEN_739" });
  assert.match(getDecision(privateState, "p1")!.prompt, /PRIVATE_TOKEN_739/);
  const second = action(privateState, "p1", "send_group_message", { channelId: "public", content: "public one" });
  assert.match(getDecision(second, "p2")!.prompt, /PRIVATE_TOKEN_739/);
  const third = action(second, "p2", "send_group_message", { channelId: "public", content: "public two" });
  assert.doesNotMatch(getDecision(third, "p3")!.prompt, /PRIVATE_TOKEN_739/);
  assert.match(projectGame(privateState).events.at(-1)!.content, /PRIVATE_TOKEN_739/);
  assert.doesNotMatch(getDecision(third, "p3")!.prompt, /PRIVATE_TOKEN_739/);
  const direct = action(initial, "p1", "send_group_message", { channelId: "public", content: "公共内容" });
  const afterPrivate = action(privateState, "p1", "send_group_message", { channelId: "public", content: "公共内容" });
  assert.deepEqual(projectGame(afterPrivate).events.filter((event) => event.visibility === "public"), projectGame(direct).events.filter((event) => event.visibility === "public"));
  const disabled = game("debate", 3, { allowPrivateMessages: false });
  assert.throws(() => action(disabled, "p1", "send_private_message", { recipientId: "p2", content: "private" }), /不允许/);
});

test("complete debate produces exactly rounds × participants committed public messages", () => {
  let state = game("debate", 4, { rounds: 3 });
  for (let round = 0; round < 3; round++) state = advanceGame(speakAll(state));
  assert.equal(state.finished, true);
  assert.equal(state.winner, "讨论完成");
  assert.equal(state.events.filter((event) => event.type === "message").length, 12);
  assert.equal(getPendingParticipantIds(state).length, 0);
  assert.deepEqual(advanceGame(state), state);
});

test("undercover role assignment is reproducible; own word only; secret voting reveals after all votes", () => {
  const initial = game("undercover", 4, { undercoverCount: 1, civilianWord: "SECRET_CIV", undercoverWord: "SECRET_SPY" });
  assert.deepEqual(initial.players, game("undercover", 4, initial.options).players);
  assert.doesNotMatch(JSON.stringify(projectGame(initial)), /SECRET_CIV|SECRET_SPY|"role"|"word"/);
  const spy = roleIds(initial, "undercover")[0];
  const civilians = roleIds(initial, "civilian");
  let description = initial;
  for (const person of description.participants) {
    const prompt = getDecision(description, person.id)!.prompt;
    if (person.id === spy) { assert.match(prompt, /SECRET_SPY/); assert.doesNotMatch(prompt, /SECRET_CIV|yourRole|wolfTeammates/); }
    else assert.doesNotMatch(prompt, /SECRET_SPY/);
    assert.throws(() => action(description, person.id, "send_private_message", { recipientId: civilians[0], content: "secret" }), /不允许/);
    description = action(description, person.id, "send_group_message", { channelId: "public", content: "我的描述" });
  }
  let state = advanceGame(speakAll(initial));
  assert.equal(state.phase, "undercover-vote");
  assert.throws(() => action(state, spy, "vote", { targetId: spy }), /范围/);
  const eventCount = projectGame(state).events.length;
  state = action(state, spy, "vote", { targetId: civilians[0] });
  assert.equal(projectGame(state).events.length, eventCount);
  assert.equal(advanceGame(state).phase, "undercover-vote");
  state = actAll(state, () => ["vote", { targetId: spy }]);
  assert.equal(projectGame(state).events.length, eventCount);
  state = advanceGame(state);
  assert.equal(state.winner, "平民获胜");
  assert.equal(projectGame(state).participants.find((p) => p.id === spy)?.role, "卧底");
  assert.match(JSON.stringify(projectGame(state)), /SECRET_SPY/);
});

test("tied votes eliminate nobody and max rounds deterministically draw", () => {
  let state = game("undercover", 4, { maxRounds: 2 });
  for (let round = 0; round < 2; round++) {
    state = advanceGame(speakAll(state));
    state = actAll(state, (_, id) => ["vote", { targetId: `p${Number(id.slice(1)) % 4 + 1}` }]);
    state = advanceGame(state);
    assert.equal(state.participants.filter((p) => state.players[p.id].alive).length, 4);
  }
  assert.equal(state.finished, true);
  assert.equal(state.winner, "达到最大回合，平局");
});

test("night projection hides subphases, action counts, actor identities, chats and inspection results", () => {
  let state = game("werewolf", 7, { werewolfCount: 2 });
  const wolves = roleIds(state, "wolf");
  const seer = roleIds(state, "seer")[0];
  const witch = roleIds(state, "witch")[0];
  const victim = roleIds(state, "villager")[0];
  const publicBefore = projectGame(state);
  assert.equal(publicBefore.pendingCount, 0);
  assert.ok(publicBefore.participants.every((p) => p.status === "idle"));
  assert.doesNotMatch(getDecision(state, wolves[0])!.prompt, /yourWord/);
  state = action(state, wolves[0], "send_group_message", { channelId: "wolves", content: "WOLF_SECRET" });
  state = action(state, wolves[0], "send_private_message", { recipientId: wolves[1], content: "PRIVATE_WOLF" });
  assert.match(getDecision(state, wolves[1])!.prompt, /WOLF_SECRET|PRIVATE_WOLF/);
  assert.throws(() => action(state, wolves[0], "kill", { targetId: wolves[1] }), /范围/);
  assert.throws(() => action(state, wolves[0], "send_private_message", { recipientId: victim, content: "illegal" }), /范围/);
  state = actAll(state, () => ["kill", { targetId: victim }]);
  assert.deepEqual(projectGame(state).events.filter((event) => event.visibility === "public"), publicBefore.events.filter((event) => event.visibility === "public"));
  state = advanceGame(state);
  assert.equal(state.phase, "night-seer");
  assert.deepEqual(projectGame(state).events.filter((event) => event.visibility === "public"), publicBefore.events.filter((event) => event.visibility === "public"));
  assert.doesNotMatch(getDecision(state, seer)!.prompt, /WOLF_SECRET|PRIVATE_WOLF|wolfTeammates|wolfTarget/);
  const inspected = applyAction(state, seer, "inspect", { targetId: wolves[0] }, "inspection", state.phaseVersion);
  assert.deepEqual(inspected.result, { accepted: true, targetId: wolves[0], isWolf: true, turnComplete: true });
  state = advanceGame(inspected.state);
  assert.equal(state.phase, "night-witch");
  assert.deepEqual(projectGame(state).events.filter((event) => event.visibility === "public"), publicBefore.events.filter((event) => event.visibility === "public"));
  assert.doesNotMatch(getDecision(state, witch)!.prompt, /查验结果|WOLF_SECRET|PRIVATE_WOLF/);
  assert.match(getDecision(state, witch)!.prompt, new RegExp(`"wolfTarget":"${victim}"`));
  assert.throws(() => action(state, witch, "inspect", { targetId: victim }), /不允许/);
  state = advanceGame(action(state, witch, "pass"));
  assert.equal(state.phase, "discussion");
  assert.equal(state.players[victim].alive, false);
  assert.doesNotMatch(JSON.stringify(projectGame(state).events.filter((event) => event.visibility === "public")), /WOLF_SECRET|PRIVATE_WOLF|查验结果|wolfTarget/);
  while (getPendingParticipantIds(state)[0] !== seer) state = action(state, getPendingParticipantIds(state)[0], "send_group_message", { channelId: "public", content: "轮到下一位" });
  assert.match(getDecision(state, seer)!.prompt, /查验结果/);
  assert.equal(projectGame(state).phaseVersion, publicBefore.phaseVersion + 1);
  assert.deepEqual(projectGame(state).events.filter((event) => event.visibility === "public" && event.type === "system").map((event) => event.id), ["event-1", "event-2"]);
});

test("witch potions are one-shot, first night self-save works, poison kills independently and permissions expire", () => {
  let state = game("werewolf", 7, { werewolfCount: 1, hasSeer: false });
  const wolf = roleIds(state, "wolf")[0];
  const witch = roleIds(state, "witch")[0];
  state = advanceGame(action(state, wolf, "kill", { targetId: witch }));
  assert.equal(state.phase, "night-witch");
  const nightVersion = state.phaseVersion;
  state = action(state, witch, "use_antidote");
  assert.equal(state.players[witch].antidote, false);
  assert.throws(() => action(state, witch, "use_poison", { targetId: wolf }), /已完成/);
  state = advanceGame(state);
  assert.equal(state.players[witch].alive, true);
  state = advanceGame(speakAll(state));
  const ids = getPendingParticipantIds(state);
  state = advanceGame(actAll(state, (_, id) => ["vote", { targetId: ids[(ids.indexOf(id) + 1) % ids.length] }]));
  assert.equal(state.round, 2);
  const victim = roleIds(state, "villager")[0];
  state = advanceGame(action(state, wolf, "kill", { targetId: victim }));
  assert.equal(state.phase, "night-witch");
  assert.doesNotMatch(getDecision(state, witch)!.prompt, /wolfTarget/);
  assert.ok(!getDecision(state, witch)!.tools.some((tool) => tool.name === "use_antidote"));
  assert.throws(() => applyAction(state, witch, "use_antidote", {}, "stale-potion", nightVersion), /过期/);
  state = advanceGame(action(state, witch, "use_poison", { targetId: wolf }));
  assert.equal(state.players[witch].poison, false);
  assert.equal(state.players[wolf].alive, false);
  assert.equal(state.players[victim].alive, false);
  assert.equal(state.winner, "好人获胜");
});

test("witch cannot self-save after first night and missing special roles skip automatically", () => {
  let state = game("werewolf", 7, { werewolfCount: 1, hasSeer: false });
  const wolf = roleIds(state, "wolf")[0]; const witch = roleIds(state, "witch")[0];
  state = advanceGame(action(state, wolf, "kill", { targetId: roleIds(state, "villager")[0] }));
  state = advanceGame(action(state, witch, "pass"));
  state = advanceGame(speakAll(state));
  const ids = getPendingParticipantIds(state);
  state = advanceGame(actAll(state, (_, id) => ["vote", { targetId: ids[(ids.indexOf(id) + 1) % ids.length] }]));
  state = advanceGame(action(state, wolf, "kill", { targetId: witch }));
  assert.ok(!getDecision(state, witch)!.tools.some((tool) => tool.name === "use_antidote"));
  assert.throws(() => action(state, witch, "use_antidote"), /不允许/);
  let plain = game("werewolf", 5, { werewolfCount: 1, hasSeer: false, hasWitch: false });
  plain = advanceGame(action(plain, roleIds(plain, "wolf")[0], "kill", { targetId: roleIds(plain, "villager")[0] }));
  assert.equal(plain.phase, "discussion");
  assert.equal(getPendingParticipantIds(plain).length, 1);
});

test("legacy host records remain visible to sequential speakers without changing the input", () => {
  const state = game("debate", 3);
  const prompt = getDecision(state, "p1")!.prompt;
  const next = addHostMessage(state, "主持人追加建议");
  assert.notEqual(getDecision(next, "p1")!.prompt, prompt);
  assert.match(getDecision(next, "p1")!.prompt, /主持人追加建议/);
  assert.equal(projectGame(next).events.at(-1)?.content, "主持人追加建议");
  assert.equal(state.events.length + 1, next.events.length);
});

test("terminal capability is explicit in tool results and wolf split targets cause a peaceful night", () => {
  let state = game("werewolf", 7, { werewolfCount: 2, hasSeer: false, hasWitch: false });
  const wolves = roleIds(state, "wolf"); const villagers = roleIds(state, "villager");
  const chat = applyAction(state, wolves[0], "send_group_message", { channelId: "wolves", content: "协商本夜目标" }, "nonterminal-chat", state.phaseVersion);
  assert.deepEqual(chat.result, { accepted: true, turnComplete: false });
  assert.ok(getPendingParticipantIds(chat.state).includes(wolves[0]));
  state = chat.state;
  const kill = applyAction(state, wolves[0], "kill", { targetId: villagers[0] }, "terminal-kill", state.phaseVersion);
  assert.deepEqual(kill.result, { accepted: true, turnComplete: true });
  state = advanceGame(action(kill.state, wolves[1], "kill", { targetId: villagers[1] }));
  assert.equal(state.phase, "discussion");
  assert.ok(state.participants.every((p) => state.players[p.id].alive));
  assert.match(projectGame(state).events.at(-1)!.content, /平安无事/);
});

test("structured ballots reveal progress only until the complete public vote is resolved", () => {
  let state = advanceGame(speakAll(game("undercover", 4)));
  const spy = roleIds(state, "undercover")[0];
  const civilians = roleIds(state, "civilian");
  const initialEvents = projectGame(state).events;
  assert.deepEqual(projectGame(state).voting, { phase: "collecting", round: 1, eligibleCount: 4, submittedCount: 0, history: [] });
  const otherTarget = action(state, spy, "vote", { targetId: civilians[1] });
  const firstVoteVersion = state.phaseVersion;
  const first = applyAction(state, spy, "vote", { targetId: civilians[0] }, "structured-first-vote", firstVoteVersion);
  state = first.state;
  assert.deepEqual(projectGame(state), projectGame(otherTarget), "Changing a secret target must not change any public field");
  assert.deepEqual(projectGame(state).voting, { phase: "collecting", round: 1, eligibleCount: 4, submittedCount: 1, history: [] });
  assert.deepEqual(projectGame(state).events, initialEvents);
  assert.deepEqual(advanceGame(state), state, "Partial ballots cannot be settled");
  state = actAll(state, () => ["vote", { targetId: spy }]);
  assert.deepEqual(projectGame(state).voting, { phase: "collecting", round: 1, eligibleCount: 4, submittedCount: 4, history: [] });
  assert.deepEqual(projectGame(state).events, initialEvents, "Even a full ballot is secret before settlement");
  state = advanceGame(state);
  const expected = {
    id: "vote-1", round: 1,
    votes: state.participants.map((participant) => ({ voterId: participant.id, targetId: participant.id === spy ? civilians[0] : spy })),
    eliminatedId: spy, tied: false,
  };
  assert.deepEqual(projectGame(state).voting, { phase: "idle", round: 1, eligibleCount: 0, submittedCount: 0, history: [expected] });
  assert.equal(state.winner, "平民获胜");
  const retried = applyAction(state, spy, "vote", { targetId: civilians[0] }, "structured-first-vote", firstVoteVersion).state;
  assert.deepEqual(retried.voteHistory, [expected], "A retry after settlement cannot append another ballot");
  assert.deepEqual(advanceGame(state).voteHistory, [expected]);
});

function completeWolfNightWithPrivateChecks(initial: GameState): GameState {
  let state = initial;
  const publicBefore = projectGame(state);
  const victim = roleIds(state, "villager").find((id) => state.players[id].alive)!;
  const wolf = roleIds(state, "wolf").find((id) => state.players[id].alive)!;
  state = actAll(state, () => ["kill", { targetId: victim }]);
  assert.deepEqual(projectGame(state), publicBefore);
  state = advanceGame(state);
  assert.equal(state.phase, "night-seer");
  assert.deepEqual(projectGame(state), publicBefore);
  state = actAll(state, () => ["inspect", { targetId: wolf }]);
  assert.deepEqual(projectGame(state), publicBefore);
  state = advanceGame(state);
  assert.equal(state.phase, "night-witch");
  assert.deepEqual(projectGame(state), publicBefore);
  state = actAll(state, () => ["pass", {}]);
  assert.deepEqual(projectGame(state), publicBefore);
  return advanceGame(state);
}
function tiedPublicVote(initial: GameState): GameState {
  const state = advanceGame(speakAll(initial));
  const ids = getPendingParticipantIds(state);
  return advanceGame(actAll(state, (_, id) => ["vote", { targetId: ids[(ids.indexOf(id) + 1) % ids.length] }]));
}

test("werewolf ballot history persists across rounds and reloads while secret night decisions leave it unchanged", () => {
  let state = game("werewolf", 7, { werewolfCount: 1, maxRounds: 2 });
  state = completeWolfNightWithPrivateChecks(state);
  state = tiedPublicVote(state);
  assert.equal(state.round, 2);
  assert.equal(state.phase, "night-wolves");
  assert.deepEqual(projectGame(state).voting, { phase: "idle", round: 2, eligibleCount: 0, submittedCount: 0, history: state.voteHistory });
  assert.equal(state.voteHistory!.length, 1);
  assert.equal(state.voteHistory![0].votes.length, 6, "Night victims are ineligible to vote");
  assert.equal(state.voteHistory![0].tied, true);
  assert.equal(state.voteHistory![0].eliminatedId, null);
  assert.ok(projectGame(state).participants.every((participant) => participant.role === undefined));
  const savedFirstRound = structuredClone(state.voteHistory![0]);
  const reloaded: GameState = JSON.parse(JSON.stringify(state));
  assert.deepEqual(projectGame(reloaded), projectGame(state));
  state = completeWolfNightWithPrivateChecks(reloaded);
  assert.deepEqual(state.voteHistory, [savedFirstRound], "Private kill and inspection records never enter public vote history");
  state = tiedPublicVote(state);
  assert.equal(state.phase, "recap");
  state = advanceGame(actAll(state, (_, id) => ["send_group_message", { channelId: "public", content: `${id} 的复盘` }]));
  assert.equal(state.finished, true);
  assert.equal(state.voteHistory!.length, 2);
  assert.deepEqual(state.voteHistory![0], savedFirstRound);
  assert.deepEqual(state.voteHistory!.map((round) => ({ id: round.id, round: round.round, tied: round.tied, eliminatedId: round.eliminatedId, count: round.votes.length })), [
    { id: "vote-1", round: 1, tied: true, eliminatedId: null, count: 6 },
    { id: "vote-2", round: 2, tied: true, eliminatedId: null, count: 5 },
  ]);
  assert.deepEqual(projectGame(JSON.parse(JSON.stringify(state))).voting, projectGame(state).voting);
  const publicCopy = projectGame(state).voting;
  publicCopy.history[0].votes[0].targetId = "client-change";
  assert.deepEqual(state.voteHistory![0], savedFirstRound, "Public projections must not alias canonical vote records");
});

test("resuming a legacy room preserves verified older ballots when the next round becomes authoritative", () => {
  let state = game("undercover", 4, { maxRounds: 2 });
  state = tiedPublicVote(state);
  assert.equal(state.voteHistory!.length, 1);
  assert.ok(state.events.some((event) => event.content.startsWith("投票结果")));
  // Simulate a pre-feature room loaded from JSON with a complete public ballot.
  const oldRecord = JSON.parse(JSON.stringify(state)) as GameState;
  delete oldRecord.voteHistory;
  const recovered = projectGame(oldRecord).voting.history;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].tied, true);
  assert.equal(recovered[0].eliminatedId, null);
  assert.deepEqual(recovered[0].votes, state.voteHistory![0].votes);
  assert.equal(oldRecord.voteHistory, undefined, "Projection does not backfill or mutate legacy records");
  const oldSnapshot = structuredClone(oldRecord);
  state = tiedPublicVote(JSON.parse(JSON.stringify(oldRecord)));
  assert.equal(state.finished, true);
  assert.deepEqual(state.voteHistory!.map((round) => round.id), [recovered[0].id, "vote-2"]);
  assert.deepEqual(state.voteHistory![0], recovered[0]);
  assert.deepEqual(projectGame(state).voting.history, state.voteHistory);
  assert.deepEqual(projectGame(JSON.parse(JSON.stringify(state))).voting.history, state.voteHistory);
  assert.deepEqual(oldRecord, oldSnapshot, "Continuing a reloaded room must not mutate its source snapshot");
  const explicitEmpty = tiedPublicVote({ ...oldRecord, voteHistory: [] });
  assert.deepEqual(explicitEmpty.voteHistory!.map((round) => round.id), ["vote-2"], "Appending to explicit [] must not inherit fallback history");
  const corrupted = structuredClone(oldRecord);
  const oldVote = corrupted.events.find((event) => event.type === "action" && event.content.startsWith("投票结果："))!;
  oldVote.content = "投票结果：格式损坏。";
  assert.deepEqual(tiedPublicVote(corrupted).voteHistory!.map((round) => round.id), ["vote-2"], "Unverified legacy text must not become authoritative on resume");
});

function completedLegacyBallots(): GameState {
  let state = advanceGame(speakAll(game("undercover", 4, { maxRounds: 2 })));
  const spy = roleIds(state, "undercover")[0];
  const eliminatedCivilian = roleIds(state, "civilian")[0];
  state = advanceGame(actAll(state, (_, id) => ["vote", { targetId: id === eliminatedCivilian ? spy : eliminatedCivilian }]));
  state = advanceGame(speakAll(state));
  const survivingCivilian = roleIds(state, "civilian").find((id) => state.players[id].alive)!;
  return advanceGame(actAll(state, (_, id) => ["vote", { targetId: id === spy ? survivingCivilian : spy }]));
}

test("strict legacy recovery handles multiple public rounds using only public inputs and honors explicit history", () => {
  const original = completedLegacyBallots();
  const legacy = JSON.parse(JSON.stringify(original)) as GameState;
  delete legacy.voteHistory;
  const snapshot = structuredClone(legacy);
  const publicOnly = { mode: legacy.mode, participants: legacy.participants, events: legacy.events.filter((event) => event.visibility === "public") };
  const recovered = deriveLegacyVoteHistory(publicOnly);
  assert.equal(recovered.length, 2);
  assert.deepEqual(recovered.map(({ id: _id, ...round }) => round), original.voteHistory!.map(({ id: _id, ...round }) => round));
  assert.ok(recovered.every((round) => round.id.startsWith("legacy-event-")));
  assert.deepEqual(projectGame(legacy).voting.history, recovered);
  assert.deepEqual(legacy, snapshot, "Compatibility projection must never mutate legacy records");
  assert.deepEqual(projectGame(JSON.parse(JSON.stringify(legacy))).voting.history, recovered);
  const explicitEmpty = { ...legacy, voteHistory: [] };
  assert.deepEqual(projectGame(explicitEmpty).voting.history, [], "An explicitly empty authoritative history must not trigger fallback");
  assert.deepEqual(projectGame(original).voting.history, original.voteHistory, "Native structured history always takes precedence");
  assert.deepEqual(deriveLegacyVoteHistory({ ...publicOnly, mode: "debate" }), []);
});

test("legacy recovery rejects malformed or ambiguous rounds and never reads player-authored or private text", () => {
  const original = completedLegacyBallots();
  const firstIndex = original.events.findIndex((event) => event.type === "action" && event.content.startsWith("投票结果："));
  const prefix = "投票结果：";
  const corruptions: Array<[string, (state: GameState) => void]> = [
    ["unknown participant", (state) => {
      const event = state.events[firstIndex]; const parts = event.content.slice(prefix.length, -1).split("；");
      parts[0] = `${parts[0].split(" → ")[0]} → 999 号 Unknown`; event.content = `${prefix}${parts.join("；")}。`;
    }],
    ["self vote", (state) => {
      const event = state.events[firstIndex]; const parts = event.content.slice(prefix.length, -1).split("；"); const voter = parts[0].split(" → ")[0];
      parts[0] = `${voter} → ${voter}`; event.content = `${prefix}${parts.join("；")}。`;
    }],
    ["duplicate voter", (state) => {
      const event = state.events[firstIndex]; const parts = event.content.slice(prefix.length, -1).split("；");
      parts[1] = parts[0]; event.content = `${prefix}${parts.join("；")}。`;
    }],
    ["changed delimiter", (state) => { state.events[firstIndex].content = state.events[firstIndex].content.replace(" → ", "→"); }],
    ["trailing text", (state) => { state.events[firstIndex].content += "unexpected"; }],
    ["incorrect result", (state) => { state.events[firstIndex + 1].content = "最高票平票，本轮无人离场。"; }],
    ["missing resolution", (state) => { state.events.splice(firstIndex + 1, 1); }],
    ["wrong resolution phase", (state) => { state.events[firstIndex + 1].phase = "night"; }],
    ["wrong resolution round", (state) => { state.events[firstIndex + 1].round = 2; }],
    ["player-authored message", (state) => { state.events[firstIndex].type = "message"; state.events[firstIndex].senderId = state.participants[0].id; }],
    ["private record", (state) => { state.events[firstIndex].visibility = "private"; }],
    ["duplicate round", (state) => { const copy = structuredClone(state.events[firstIndex]); copy.id = "duplicate-public-round"; state.events.splice(firstIndex + 2, 0, copy); }],
  ];
  for (const [name, corrupt] of corruptions) {
    const changed = structuredClone(original);
    delete changed.voteHistory;
    corrupt(changed);
    assert.deepEqual(projectGame(changed).voting.history.map((round) => round.round), [2], `Uncertain first round must be skipped: ${name}`);
  }
  const ambiguousName = structuredClone(original);
  delete ambiguousName.voteHistory;
  ambiguousName.participants[0].modelName = "Model；with → structural punctuation";
  assert.deepEqual(projectGame(ambiguousName).voting.history, [], "Ambiguous label grammar must fail closed");
  const duplicateSeat = structuredClone(original);
  delete duplicateSeat.voteHistory;
  duplicateSeat.participants[1].seat = duplicateSeat.participants[0].seat;
  assert.deepEqual(projectGame(duplicateSeat).voting.history, []);
});

test("legacy history remains identical through a complete secret night and does not recover secret wolf targets", () => {
  let state = game("werewolf", 7, { werewolfCount: 1, maxRounds: 3 });
  state = tiedPublicVote(completeWolfNightWithPrivateChecks(state));
  assert.equal(state.phase, "night-wolves");
  delete state.voteHistory;
  const recovered = projectGame(state).voting.history;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].tied, true);
  state = completeWolfNightWithPrivateChecks(state);
  assert.deepEqual(projectGame(state).voting.history, recovered);
  assert.equal(state.voteHistory, undefined);
});

test("werewolf day speeches are called in order, hear earlier claims, and recap after victory", () => {
  let state = game("werewolf", 6, { werewolfCount: 1, hasSeer: false, hasWitch: false, revealRolesAtStart: true });
  assert.ok(projectGame(state).participants.every((person) => person.role));
  const wolf = roleIds(state, "wolf")[0];
  state = advanceGame(action(state, wolf, "kill", { targetId: roleIds(state, "villager")[0] }));
  assert.equal(state.phase, "discussion");
  const first = getPendingParticipantIds(state)[0];
  assert.equal(projectGame(state).participants.filter((person) => person.status === "thinking").length, 1);
  assert.equal(projectGame(state).participants.find((person) => person.id === first)?.status, "thinking");
  assert.throws(() => action(state, getPendingParticipantIds({ ...state, completed: [first] })[0], "send_group_message", { channelId: "public", content: "抢先发言" }), /权限/);
  state = action(state, first, "send_group_message", { channelId: "public", content: "我怀疑有人反跳预言家" });
  const second = getPendingParticipantIds(state)[0];
  assert.match(getDecision(state, second)!.prompt, /我怀疑有人反跳预言家/);
  state = actAll(state, (_, id) => ["send_group_message", { channelId: "public", content: `${id} 依次回应` }]);
  assert.equal(advanceGame(state).phase, "day-vote");
});

test("spectator role reveal stays visible to viewers but out of every player's prompt, including legacy public records", () => {
  const state = game("werewolf", 8, { werewolfCount: 2, hasSeer: true, hasWitch: true, revealRolesAtStart: true });
  const reveal = projectGame(state).events.find((event) => event.content.startsWith("本局身份公开："));
  assert.ok(reveal);
  assert.equal(reveal.visibility, "spectator");
  assert.ok(projectGame(state).participants.every((person) => person.role));
  for (const participant of state.participants) {
    const prompt = getDecision(state, participant.id);
    if (!prompt) continue;
    assert.ok(prompt.prompt.includes("yourRole"));
    assert.ok(!prompt.prompt.includes(reveal.content), `席位 ${participant.seat} 不应收到观众身份表`);
    assert.doesNotMatch(prompt.prompt, /本局身份公开：/);
  }
  const legacy = structuredClone(state);
  const oldReveal = legacy.events.find((event) => event.content.startsWith("本局身份公开："))!;
  oldReveal.visibility = "public";
  legacy.phaseSnapshot = structuredClone(legacy.events.filter((event) => event.visibility === "public"));
  for (const id of getPendingParticipantIds(legacy)) assert.doesNotMatch(getDecision(legacy, id)!.prompt, /本局身份公开：/);
  let legacyDay = game("werewolf", 7, { werewolfCount: 1, hasSeer: false, hasWitch: false, revealRolesAtStart: true });
  const dayReveal = legacyDay.events.find((event) => event.content.startsWith("本局身份公开："))!;
  dayReveal.visibility = "public";
  legacyDay.phaseSnapshot = structuredClone(legacyDay.events.filter((event) => event.visibility === "public"));
  legacyDay = advanceGame(action(legacyDay, roleIds(legacyDay, "wolf")[0], "kill", { targetId: roleIds(legacyDay, "villager")[0] }));
  assert.equal(legacyDay.phase, "discussion");
  assert.doesNotMatch(getDecision(legacyDay, getPendingParticipantIds(legacyDay)[0])!.prompt, /本局身份公开：/);
});

test("new werewolf roles have distinct seats and keep the spectator's initial role count consistent", () => {
  const state = game("werewolf", 10, {
    werewolfCount: 2, hasSeer: true, hasWitch: true,
    hasHunter: true, hasGuard: true, hasBomber: true, hasWolfKing: true,
  });
  for (const role of ["wolf-king", "wolf", "seer", "witch", "hunter", "guard", "bomber"]) {
    assert.equal(roleIds(state, role).length, 1, `${role} 应占一个独立席位`);
  }
  assert.equal(roleIds(state, "villager").length, 3);
  assert.ok(projectGame(state).participants.every((person) => person.role === undefined));
});

test("guard protects the wolf target and cannot guard the same person on consecutive nights", () => {
  let state = game("werewolf", 8, { werewolfCount: 1, hasSeer: false, hasWitch: false, hasGuard: true });
  const guard = roleIds(state, "guard")[0];
  const wolf = roleIds(state, "wolf")[0];
  const target = roleIds(state, "villager")[0];
  assert.equal(state.phase, "night-guard");
  const beforeNight = projectGame(state);
  state = advanceGame(action(state, guard, "guard", { targetId: target }));
  assert.equal(state.phase, "night-wolves");
  assert.deepEqual(projectGame(state), beforeNight, "守人行动和秘密子阶段不应改变观众快照");
  state = advanceGame(action(state, wolf, "kill", { targetId: target }));
  assert.equal(state.phase, "discussion");
  assert.equal(state.players[target].alive, true);
  assert.match(projectGame(state).events.at(-1)!.content, /平安无事/);
  state = tiedPublicVote(state);
  assert.equal(state.phase, "night-guard");
  assert.throws(() => action(state, guard, "guard", { targetId: target }), /范围|连续|同一/);
  state = advanceGame(action(state, guard, "guard", { targetId: guard }));
  assert.equal(state.phase, "night-wolves");
  state = advanceGame(action(state, wolf, "kill", { targetId: guard }));
  assert.equal(state.players[guard].alive, true, "守卫可以守自己");
});

test("living wolf king orders the night target without waiting for ordinary wolves", () => {
  let state = game("werewolf", 9, { werewolfCount: 2, hasWolfKing: true, hasSeer: true, hasWitch: false });
  const king = roleIds(state, "wolf-king")[0];
  const ordinaryWolf = roleIds(state, "wolf")[0];
  const seer = roleIds(state, "seer")[0];
  const victim = roleIds(state, "villager")[0];
  assert.deepEqual(getPendingParticipantIds(state), [king]);
  assert.ok(getDecision(state, king)!.tools.some((tool) => tool.name === "command_kill"));
  assert.match(getDecision(state, king)!.prompt, new RegExp(`"${ordinaryWolf}"`));
  assert.equal(getDecision(state, ordinaryWolf), null);
  assert.throws(() => action(state, ordinaryWolf, "kill", { targetId: victim }), /权限/);
  state = action(state, king, "command_kill", { targetId: victim });
  assert.deepEqual(getPendingParticipantIds(state), []);
  state = advanceGame(state);
  assert.equal(state.phase, "night-seer");
  const inspection = applyAction(state, seer, "inspect", { targetId: king }, `action-${++actionNumber}`, state.phaseVersion);
  assert.deepEqual(inspection.result, { accepted: true, targetId: king, isWolf: true, turnComplete: true });
  state = advanceGame(inspection.state);
  assert.equal(state.phase, "discussion");
  assert.equal(state.players[victim].alive, false);
});

test("hunter may shoot after a wolf kill before victory is settled", () => {
  let state = game("werewolf", 8, { werewolfCount: 1, hasSeer: false, hasWitch: false, hasHunter: true });
  const wolf = roleIds(state, "wolf")[0];
  const hunter = roleIds(state, "hunter")[0];
  assert.throws(() => action(state, hunter, "shoot", { targetId: wolf }), /权限|不允许/);
  state = advanceGame(action(state, wolf, "kill", { targetId: hunter }));
  assert.equal(state.phase, "death-reaction");
  assert.equal(state.players[hunter].alive, false);
  assert.deepEqual(getPendingParticipantIds(state), [hunter]);
  assert.ok(getDecision(state, hunter)!.tools.some((tool) => tool.name === "shoot"));
  assert.equal(state.winner, null);
  state = advanceGame(action(state, hunter, "shoot", { targetId: wolf }));
  assert.equal(state.players[wolf].alive, false);
  assert.equal(state.winner, "好人获胜");
  assert.equal(state.phase, "recap");
});

test("voted-out hunter may pass instead of shooting", () => {
  let state = game("werewolf", 8, { werewolfCount: 1, hasSeer: false, hasWitch: false, hasHunter: true });
  const wolf = roleIds(state, "wolf")[0];
  const hunter = roleIds(state, "hunter")[0];
  state = advanceGame(action(state, wolf, "kill", { targetId: roleIds(state, "villager")[0] }));
  state = advanceGame(speakAll(state));
  state = advanceGame(actAll(state, (_, id) => ["vote", { targetId: id === hunter ? wolf : hunter }]));
  assert.equal(state.phase, "death-reaction");
  assert.ok(getDecision(state, hunter)!.tools.some((tool) => tool.name === "pass"));
  state = advanceGame(action(state, hunter, "pass"));
  assert.equal(state.players[hunter].alive, false);
  assert.equal(state.players[wolf].alive, true);
  assert.equal(state.phase, "night-wolves");
});

test("voted-out bomber detonates before victory is settled", () => {
  let state = game("werewolf", 8, { werewolfCount: 1, hasSeer: false, hasWitch: false, hasBomber: true });
  const wolf = roleIds(state, "wolf")[0];
  const bomber = roleIds(state, "bomber")[0];
  assert.throws(() => action(state, bomber, "detonate", { targetId: wolf }), /权限|不允许/);
  const firstVictim = roleIds(state, "villager")[0];
  state = advanceGame(action(state, wolf, "kill", { targetId: firstVictim }));
  assert.equal(state.phase, "discussion");
  state = advanceGame(speakAll(state));
  assert.equal(state.phase, "day-vote");
  state = advanceGame(actAll(state, (_, id) => ["vote", { targetId: id === bomber ? wolf : bomber }]));
  assert.equal(state.phase, "death-reaction");
  assert.deepEqual(getPendingParticipantIds(state), [bomber]);
  assert.equal(state.players[bomber].alive, false);
  assert.equal(state.winner, null);
  state = advanceGame(action(state, bomber, "detonate", { targetId: wolf }));
  assert.equal(state.players[wolf].alive, false);
  assert.equal(state.winner, "好人获胜");
  assert.equal(state.phase, "recap");
});

test("the called wolf may self-explode, skip all remaining speeches and vote, then enter night", () => {
  let state = game("werewolf", 9, { werewolfCount: 2, hasSeer: false, hasWitch: false });
  const victim = roleIds(state, "villager")[0];
  state = advanceGame(actAll(state, () => ["kill", { targetId: victim }]));
  assert.equal(state.phase, "discussion");
  while (state.players[getPendingParticipantIds(state)[0]].role !== "wolf") {
    state = action(state, getPendingParticipantIds(state)[0], "send_group_message", { channelId: "public", content: "先发言" });
  }
  const explodingWolf = getPendingParticipantIds(state)[0];
  const speakingOrder = getPendingParticipantIds({ ...state, completed: [...state.completed, explodingWolf] });
  assert.ok(getDecision(state, explodingWolf)!.tools.some((tool) => tool.name === "explode"));
  state = action(state, explodingWolf, "explode");
  assert.equal(state.players[explodingWolf].alive, false);
  assert.equal(state.phase, "night-wolves");
  assert.equal(state.round, 2);
  assert.equal(state.voteHistory?.length, 0);
  assert.equal(state.events.some((event) => event.content.includes("自爆")), true);
  assert.ok(speakingOrder.every((id) => !state.decisions[id]));
});

test("self-explosion on the last allowed round cannot start an extra night", () => {
  let state = game("werewolf", 9, { werewolfCount: 2, hasSeer: false, hasWitch: false, maxRounds: 1 });
  state = advanceGame(actAll(state, () => ["kill", { targetId: roleIds(state, "villager")[0] }]));
  while (state.players[getPendingParticipantIds(state)[0]].role !== "wolf") {
    state = action(state, getPendingParticipantIds(state)[0], "send_group_message", { channelId: "public", content: "先发言" });
  }
  state = action(state, getPendingParticipantIds(state)[0], "explode");
  assert.equal(state.round, 1);
  assert.equal(state.winner, "达到最大回合，平局");
  assert.equal(state.phase, "recap");
});
