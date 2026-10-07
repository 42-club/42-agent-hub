import { getPendingParticipantIds } from "../src/domain/engine";
import type { Participant } from "../src/domain/types";
import type { RoomRecord } from "./store";

export function participantFailureLabel(participant: Participant): string {
  return `${participant.seat} 号 ${participant.modelName}（${participant.modelId}）`;
}

export function canIdentifyFailedParticipant(room: Pick<RoomRecord, "game">): boolean {
  const game = room.game;
  return game.mode !== "werewolf" || !game.phase.startsWith("night-") || game.options.revealRolesAtStart === true;
}

/** Older secret-phase errors used "模型" instead of the failed seat. Pending
 * actions are authoritative after all jobs have settled and been persisted. */
export function displayRoomError(room: Pick<RoomRecord, "status" | "error" | "game">): string | null {
  if (room.status !== "error" || !room.error?.startsWith("模型：")) return room.error;
  if (!canIdentifyFailedParticipant(room)) return room.error;
  const pending = new Set(getPendingParticipantIds(room.game));
  const participants = room.game.participants.filter((participant) => pending.has(participant.id));
  if (!participants.length) return room.error;
  return `${participants.map(participantFailureLabel).join("、")}：${room.error.slice("模型：".length)}`;
}
