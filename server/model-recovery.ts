import { getPendingParticipantIds } from "../src/domain/engine";
import type { RoomRecord } from "./store";
import type { ModelAttempt } from "./platform-models";

/** Recovery metadata is not projected in hidden-role games, including its timing. */
export function publicModelRecovery(room: RoomRecord): "retrying" | "fallback" | undefined {
  if (room.status !== "running" || room.input.mode !== "debate") return undefined;
  const pending = new Set(getPendingParticipantIds(room.game));
  const latest = new Map<string, ModelAttempt>();
  for (const attempt of room.modelAttempts ?? []) if (attempt.phaseVersion === room.game.phaseVersion && pending.has(attempt.participantId)) latest.set(attempt.participantId, attempt);
  for (const attempt of latest.values()) {
    if (attempt.status === "started" && attempt.recovery) return attempt.recovery;
    if (attempt.next === "retry") return "retrying";
    if (attempt.next === "fallback") return "fallback";
  }
  return undefined;
}
