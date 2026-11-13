import type { RefObject } from "react";
import type {
  CanvasOperation,
  CanvasStatus,
  DrawingCanvasHandle,
  DrawingSettings,
} from "@/contracts/drawing";
import type { GuessHeatmapV1 } from "../../../../../packages/game-contracts/src/ai-inference";

export type FreeDrawMode = "free" | "prompt";
export type FreeDrawFeature = "guesser" | "referee" | "heatmap";
export type FeatureStatus =
  | "off"
  | "waiting"
  | "working"
  | "ready"
  | "unavailable"
  | "solved";
export interface FreeDrawPrediction {
  id: string;
  answer: string;
  confidence: number;
  submitted: boolean;
  correct?: boolean;
}
export interface FreeDrawController {
  canvasRef: RefObject<DrawingCanvasHandle | null>;
  settings: DrawingSettings;
  setSettings(settings: DrawingSettings): void;
  canvasStatus: CanvasStatus;
  onStatusChange(status: CanvasStatus): void;
  onOperation(operation: CanvasOperation): void;
  mode: FreeDrawMode;
  setMode(mode: FreeDrawMode): void;
  prompt: string;
  setPrompt(prompt: string): void;
  labels: string[];
  toggles: Record<FreeDrawFeature, boolean>;
  toggle(feature: FreeDrawFeature): void;
  history: FreeDrawPrediction[];
  solved: boolean;
  heatmap?: GuessHeatmapV1;
  heatmapGuess?: { answer: string; confidence: number };
  heatmapKey: string;
  warning?: { confidence: number };
  availability: Record<FreeDrawFeature, FeatureStatus>;
  error: string;
  saveError: string;
  loading: boolean;
  clearHistory(): void;
  restartGuesser(): void;
  clearCanvas(): void;
  randomPrompt(): void;
}
