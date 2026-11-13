import type { FreeDrawCapabilities } from "../../../../../packages/game-contracts/src/free-draw";
import type { FreeDrawFeature, FreeDrawMode } from "./types";
import type { FreeDrawPrediction } from "./types";

export type FreeDrawRole = "guesser" | "referee";
export function normalizeFreeDrawLabel(label: string): string {
  return label.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}
export function shouldAnalyze(input: {
  loading: boolean;
  hidden: boolean;
  busy: boolean;
  hasInk: boolean;
  inFlight: boolean;
}): boolean {
  return (
    !input.loading &&
    !input.hidden &&
    !input.busy &&
    input.hasInk &&
    !input.inFlight
  );
}
export function planRoles(input: {
  toggles: Record<FreeDrawFeature, boolean>;
  mode: FreeDrawMode;
  prompt: string;
  solved: boolean;
  capabilities: FreeDrawCapabilities;
  successfulRevision: Partial<Record<FreeDrawRole, number>>;
  revision: number;
  retryAt: Partial<Record<FreeDrawRole, number>>;
  now: number;
}): FreeDrawRole[] {
  const roles: FreeDrawRole[] = [];
  const hasPromptOrFreeMode = input.mode === "free" || Boolean(input.prompt);
  const wantsGuesser =
    (input.toggles.guesser &&
      hasPromptOrFreeMode &&
      !(input.mode === "prompt" && input.solved)) ||
    input.toggles.heatmap;
  if (
    wantsGuesser &&
    input.capabilities.guesser.available &&
    (input.retryAt.guesser ?? 0) <= input.now &&
    input.successfulRevision.guesser !== input.revision
  )
    roles.push("guesser");
  if (
    input.toggles.referee &&
    input.capabilities.referee.available &&
    (input.retryAt.referee ?? 0) <= input.now &&
    input.successfulRevision.referee !== input.revision
  )
    roles.push("referee");
  return roles;
}
export function predictionFromAnswer(input: {
  id: string;
  answer: string;
  confidence: number;
  mode: FreeDrawMode;
  prompt: string;
}): FreeDrawPrediction {
  const submitted = input.confidence > 0.5;
  const correct =
    submitted &&
    input.mode === "prompt" &&
    normalizeFreeDrawLabel(input.answer) ===
      normalizeFreeDrawLabel(input.prompt);
  return {
    id: input.id,
    answer: input.answer,
    confidence: input.confidence,
    submitted,
    ...(submitted && input.mode === "prompt" ? { correct } : {}),
  };
}
