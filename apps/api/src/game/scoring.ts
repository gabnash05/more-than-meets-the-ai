/** Provisional v1 balance. AI is unavailable until a real provider is integrated. */
export const SCORING_VERSION = "human-v1";
export interface HumanSolve {
  playerId: string;
  elapsedMs: number;
}
export interface ScoreComponent {
  guesserBase: number;
  aiAdjustment: number;
  drawerRecognition: number;
  drawerBonus: number;
}
export function speedPoints(elapsedMs: number, durationMs: number): number {
  const fraction = Math.max(0, Math.min(1, elapsedMs / durationMs));
  return Math.round(100 - 70 * fraction);
}
export function individualScores(
  drawerId: string,
  eligible: string[],
  solves: HumanSolve[],
  durationMs: number,
): Record<string, ScoreComponent> {
  const results: Record<string, ScoreComponent> = {};
  const unique = new Map<string, HumanSolve>();
  for (const solve of solves)
    if (eligible.includes(solve.playerId) && !unique.has(solve.playerId))
      unique.set(solve.playerId, solve);
  for (const id of eligible) {
    const solve = unique.get(id);
    results[id] = {
      guesserBase: solve ? speedPoints(solve.elapsedMs, durationMs) : 0,
      aiAdjustment: 0,
      drawerRecognition: 0,
      drawerBonus: 0,
    };
  }
  const raw = [...unique.values()].reduce(
    (sum, solve) => sum + speedPoints(solve.elapsedMs, durationMs),
    0,
  );
  results[drawerId] = {
    guesserBase: 0,
    aiAdjustment: 0,
    drawerRecognition: eligible.length
      ? Math.round((60 * raw) / (eligible.length * 100))
      : 0,
    drawerBonus: 0,
  };
  return results;
}
export function teamScore(
  solve: HumanSolve | undefined,
  durationMs: number,
): number {
  return solve ? speedPoints(solve.elapsedMs, durationMs) : 0;
}
