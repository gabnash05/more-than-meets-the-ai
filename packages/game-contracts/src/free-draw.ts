import type { GuessHeatmapV1, GuessAlternativeV1 } from "./ai-inference";

export interface FreeDrawCapabilities {
  guesser: { available: boolean; labels: string[] };
  referee: { available: boolean };
  minIntervalMs: number;
  refereeMinIntervalMs?: number;
}

export interface FreeDrawSession {
  sessionId: string;
  token: string;
  capabilities: FreeDrawCapabilities;
}

export interface FreeDrawObservation {
  runId: string;
  revision: number;
  requestId: string;
  roles: ("guesser" | "referee")[];
}
export type FreeDrawOutcome =
  | { status: "answer"; answer: string; confidence: number; heatmap?: GuessHeatmapV1; alternatives?: GuessAlternativeV1[] }
  | { status: "pass"; reason?: string }
  | { status: "evidence"; scores: [number, number] }
  | { status: "unavailable"; reason: string };
export interface FreeDrawResult extends FreeDrawObservation {
  sessionId: string;
  outcomes: Partial<Record<"guesser" | "referee", FreeDrawOutcome>>;
}
