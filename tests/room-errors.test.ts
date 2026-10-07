import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceGame, applyAction, createGame, getPendingParticipantIds } from "../src/domain/engine";
import { DEFAULT_OPTIONS, type Participant } from "../src/domain/types";
import { canIdentifyFailedParticipant, displayRoomError, participantFailureLabel } from "../server/room-errors";

test("model failures identify the seat and model ID, including saved secret-phase errors", () => {
  const participants: Participant[] = Array.from({ length: 6 }, (_, index) => ({
    id: `p${index + 1}`, agentId: `a${index + 1}`, providerId: "provider", vendor: "test",
    modelId: `vendor/model-${index + 1}`, modelName: `模型 ${index + 1}`, color: "#123456", seat: index + 1,
  }));
  let game = createGame("werewolf", participants, { ...DEFAULT_OPTIONS, werewolfCount: 1, hasSeer: false, hasWitch: true }, "", "error-test");
  const wolf = participants.find((person) => game.players[person.id].role === "wolf")!;
  const villager = participants.find((person) => game.players[person.id].role === "villager")!;
  game = advanceGame(applyAction(game, wolf.id, "kill", { targetId: villager.id }, "wolf-kill", game.phaseVersion).state);
  assert.equal(game.phase, "night-witch");
  const witch = participants.find((person) => person.id === getPendingParticipantIds(game)[0])!;
  const expected = participantFailureLabel(witch);
  assert.match(expected, new RegExp(`${witch.seat} 号 ${witch.modelName}`));
  assert.match(expected, /vendor\/model-/);
  const error = "模型：上游模型请求失败。已确认的行动已保存，点击继续只重试未完成的席位。";
  assert.equal(canIdentifyFailedParticipant({ game }), false);
  assert.equal(displayRoomError({ status: "error", error, game }), error);
  game.options.revealRolesAtStart = true;
  assert.equal(canIdentifyFailedParticipant({ game }), true);
  assert.equal(displayRoomError({ status: "error", error, game }), `${expected}：${error.slice("模型：".length)}`);
  assert.equal(displayRoomError({ status: "running", error, game }), error);
});
