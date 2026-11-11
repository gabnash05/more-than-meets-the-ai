/** Durable, JSON-compatible room state. Runtime timers and connection IDs are not stored. */
export interface PersistedRoom {
  code: string;
  state: Record<string, unknown>;
}

/** A contiguous accepted canvas batch, keyed by its final sequence. */
export interface DrawingRecord {
  roomCode: string;
  canvasId: string;
  generation: number;
  sequence: number;
  operations: unknown[];
}

/** Committing a turn and its resulting room state must be atomic and idempotent. */
export interface FinalizedTurn {
  room: PersistedRoom;
  turnId: string;
  generation: number;
  results: Record<string, unknown>;
}

export interface GameStore {
  loadRooms(): Promise<PersistedRoom[]>;
  saveRoom(room: PersistedRoom): Promise<void>;
  appendDrawing(record: DrawingRecord): Promise<void>;
  loadDrawing(
    roomCode: string,
    canvasId: string,
    generation: number,
  ): Promise<DrawingRecord[]>;
  finalizeTurn(record: FinalizedTurn): Promise<void>;
}

export type EventSink = (connectionId: string, event: unknown) => void;
export type DisconnectSink = (connectionId: string) => void;

/** Future inference integration: authorized observation only; it receives no secret target. */
export interface GuesserObservation {
  jobId: string;
  turnId: string;
  deadlineAt: number;
  canvasId: string;
  generation: number;
  sequence: number;
  hint: string;
}
export type GuesserResult = { jobId: string; status: "answer"; answer: string; confidence?: number } | { jobId: string; status: "unavailable"; reason?: string };
export interface GuesserProvider {
  guess(observation: GuesserObservation): Promise<GuesserResult>;
}
