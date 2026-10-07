export type GameMode = "debate" | "undercover" | "werewolf";
export type RoomStatus = "waiting" | "running" | "paused" | "completed" | "error";
export type ProviderKind = "openrouter" | "openai-compatible";

export interface ProviderConnection {
  organizationId?: string;
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  configured: boolean;
}

/** Identity is independent of model identity. Two entities may use the same model. */
export interface AgentEntity {
  organizationId?: string;
  id: string;
  providerId: string;
  vendor: string;
  modelId: string;
  modelName: string;
  color: string;
  createdAt: string;
}

export interface RoomOptions {
  rounds: number;
  allowPrivateMessages: boolean;
  undercoverCount: number;
  civilianWord: string;
  undercoverWord: string;
  werewolfCount: number;
  hasSeer: boolean;
  hasWitch: boolean;
  hasHunter: boolean;
  hasGuard: boolean;
  hasBomber: boolean;
  hasWolfKing: boolean;
  maxRounds: number;
  revealRolesAtStart: boolean;
}

export interface CreateRoomInput {
  joinAsParticipant?: boolean;
  title: string;
  topic: string;
  mode: GameMode;
  agentIds: string[];
  executionMode: "demo" | "live";
  options: RoomOptions;
}

export interface Participant {
  kind?: "agent" | "human";
  userId?: string;
  id: string;
  agentId: string;
  providerId: string;
  vendor: string;
  modelId: string;
  modelName: string;
  color: string;
  seat: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface GameEvent {
  id: string;
  type: "message" | "system" | "action";
  senderId: string | null;
  content: string;
  visibility: "public" | "private" | "wolves" | "spectator";
  recipientIds: string[];
  round: number;
  phase: string;
  createdAt: string;
}

export interface ParticipantView extends Participant {
  alive: boolean;
  status: "idle" | "thinking" | "done" | "eliminated" | "error";
  role?: string;
  word?: string;
  pid?: number;
}

export interface RoomSummary {
  id: string;
  title: string;
  topic: string;
  mode: GameMode;
  status: RoomStatus;
  executionMode: "demo" | "live";
  participantCount: number;
  modelNames: string[];
  round: number;
  phaseLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoteRecord {
  voterId: string;
  targetId: string;
}

/** A public ballot is available only after the complete round has been resolved. */
export interface VoteRoundView {
  id: string;
  round: number;
  votes: VoteRecord[];
  eliminatedId: string | null;
  tied: boolean;
}

export interface VotingView {
  phase: "collecting" | "idle";
  round: number;
  eligibleCount: number;
  submittedCount: number;
  history: VoteRoundView[];
}

export interface RoomView extends RoomSummary {
  executionGeneration?: number;
  self?: {
    participantId: string;
    role?: string;
    word?: string;
    wolfTeammates?: string[];
    wolfTarget?: string | null;
    phaseVersion: number;
    tools: ToolSpec[];
  };
  canControl?: boolean;
  participants: ParticipantView[];
  events: GameEvent[];
  privateMessages: GameEvent[];
  options: Omit<RoomOptions, "civilianWord" | "undercoverWord">;
  winner: string | null;
  error: string | null;
  phaseVersion: number;
  pendingCount: number;
  completedCount: number;
  voting?: VotingView;
}

export interface DashboardData {
  agents: AgentEntity[];
  providers: ProviderConnection[];
  rooms: RoomSummary[];
}

export interface ModelOption {
  id: string;
  name: string;
  vendor: string;
}

export const DEFAULT_OPTIONS: RoomOptions = {
  rounds: 3,
  allowPrivateMessages: true,
  undercoverCount: 1,
  civilianWord: "咖啡",
  undercoverWord: "奶茶",
  werewolfCount: 2,
  hasSeer: true,
  hasWitch: true,
  hasHunter: false,
  hasGuard: false,
  hasBomber: false,
  hasWolfKing: false,
  maxRounds: 10,
  revealRolesAtStart: false,
};

export const MODE_LABELS: Record<GameMode, string> = {
  debate: "圆桌辩论",
  undercover: "谁是卧底",
  werewolf: "狼人杀",
};
