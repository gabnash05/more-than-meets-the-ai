import type { PlayerProfile } from "./player";
import type { DrawingBatch, CanvasOperation } from "./drawing";
export type RoomMode = "individual" | "team";
export interface RoomSettings {
  mode: RoomMode;
  seats: number;
  teamCount: number;
  seatsPerTeam: number;
  rounds: number;
  aiGuesserEnabled?: boolean;
  aiRefereeEnabled?: boolean;
}
export interface RoomPlayer {
  id: string;
  profile: PlayerProfile;
  connected: boolean;
  teamId?: string;
  joinedAt: number;
  solved?: boolean;
  score?: number;
}
export interface RoomTeam {
  id: string;
  name: string;
  capacity?: number;
}
export interface ChatMessage {
  id: string;
  playerId: string;
  text: string;
  at: number;
  kind?: "chat" | "correct" | "system";
}
export interface AiRoundResult {
  scoringVersion: "ai-benchmark-v1";
  status: "solved" | "unsolved" | "unavailable";
  points: number | null;
  elapsedMs: number | null;
  reason?: string;
}
export interface AiBenchmarkSummary {
  totalPoints: number | null;
  scoredRounds: number;
  solvedRounds: number;
  completedRounds: number;
}
export interface AiGuess {
  answer: string;
  confidence?: number;
  elapsedMs?: number;
  submitted?: boolean;
}
export interface AiRoundHistory {
  round: number;
  drawerId: string;
  word: string;
  aiBenchmark: AiRoundResult;
  aiGuesses?: AiGuess[];
}
export interface AiGuessEvent {
  type: "ai-guess";
  jobId: string;
  canvasId: string;
  generation: number;
  correct: boolean;
}
export interface RefereeWarning {
  confidence: number;
  expiresAt: number;
}
export interface RoomGame {
  choosingPlayerId?: string;
  teamProgress?: { teamId: string; drawerId: string; status: "choosing" | "drawing" | "solved" | "finished"; solvedBy?: string; score?: number }[];
  deadlineAt?: number;
  pause?: { reason: "drawer-disconnected" | "guessers-disconnected"; until: number; remainingMs: number };
  sync?: { sequence: number; durableSequence: number };
  position?: { round: number };
  saving?: "idle" | "saving" | "blocked";
  /** The current drawing turn is closed; its results are not yet published. */
  closing?: boolean;
  scoringEligibility?: { eligible: boolean; reason?: string };
  generation: number;
  canvasId: string;
  drawerId: string;
  hint: string;
  time: string;
  scores: Record<string, number>;
  round?: number;
  aiStatus?: "waiting" | "guessing" | "correct" | "wrong" | "unavailable";
  refereeWarning?: RefereeWarning;
  result?: {
    aiBenchmark?: AiRoundResult;
    word: string;
    aiAnswers: string[];
    aiGuesses?: AiGuess[];
    aiCorrect: boolean;
    deltas: Record<string, number>;
    nextDrawerId?: string;
    finalAnswer?: string;
    countdown?: number;
    components?: Record<
      string,
      {
        guesserBase?: number;
        aiAdjustment?: number;
        drawerRecognition?: number;
        drawerBonus?: number;
      }
    >;
  };
}
export interface RoomSnapshot {
  aiBenchmark?: AiBenchmarkSummary;
  aiHistory?: AiRoundHistory[];
  startDeadlineAt?: number;
  code: string;
  revision: number;
  settings: RoomSettings;
  players: RoomPlayer[];
  teams: RoomTeam[];
  hostId: string;
  phase: "lobby" | "starting" | "choosing" | "drawing" | "result" | "finished" | "interrupted" | "closed";
  serverTime?: number;
  interruptedSketches?: { canvasId: string; generation: number; sequence?: number }[];
  finalStandings?: { playerId?: string; teamId?: string; score: number }[];
  winners?: string[];
  chat: ChatMessage[];
  startBlockers?: string[];
  hostDisconnectedUntil?: number;
  canReturnToLobby?: boolean;
  game?: RoomGame;
}
export interface PrivateRoomState {
  role?: "drawer" | "guesser" | "spectator";
  target?: string;
  promptOptions?: { id: string; label: string }[];
}
export interface RoomSession {
  snapshot: RoomSnapshot;
  playerId: string;
  resumeToken: string;
  privateState?: PrivateRoomState;
  demo: boolean;
}
export type RoomEvent =
  | AiGuessEvent
  | {
      type: "snapshot";
      snapshot: RoomSnapshot;
      privateState?: PrivateRoomState;
    }
  | {
      type: "connection";
      status: "connecting" | "connected" | "disconnected" | "restoring";
      message?: string;
    }
  | {
      type: "drawing";
      canvasId: string;
      generation: number;
      sequence: number;
      reset: boolean;
      caughtUp: boolean;
      operations: CanvasOperation[];
    }
  /** Client-local count of batches not yet accepted; durability is reported by game.sync. */
  | { type: "drawing-queue"; pending: number }
  | { type: "ack"; batchId: string; accepted: boolean; message?: string }
  | { type: "gameplay"; name: string; payload?: unknown };
export interface InterruptedSketch { canvasId: string; generation: number; sequence: number; operations: CanvasOperation[] }
export interface RoomClient {
  create(profile: PlayerProfile): Promise<RoomSession>;
  join(code: string, profile: PlayerProfile): Promise<RoomSession>;
  resume(code: string, resumeToken: string): Promise<RoomSession>;
  updateSettings(settings: RoomSettings): Promise<void>;
  movePlayer(playerId: string, teamId: string): Promise<void>;
  selectTeam(teamId: string): Promise<void>;
  start(): Promise<void>;
  choosePrompt(id: string): Promise<void>;
  retryInterrupted(): Promise<void>;
  getInterruptedSketch(canvasId: string, generation: number): Promise<InterruptedSketch>;
  returnToLobby(): Promise<void>;
  leave(): Promise<void>;
  sendChat(text: string): Promise<void>;
  submitGuess(text: string): Promise<void>;
  submitDrawing(batch: DrawingBatch): Promise<void>;
  resync(): Promise<void>;
  getSession(): RoomSession | null;
  subscribe(listener: (event: RoomEvent) => void): () => void;
  dispose(): void;
}
export class RoomClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
    this.name = "RoomClientError";
  }
}
export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  mode: "individual",
  seats: 6,
  teamCount: 2,
  seatsPerTeam: 6,
  rounds: 6,
  aiGuesserEnabled: true,
  aiRefereeEnabled: true,
};
