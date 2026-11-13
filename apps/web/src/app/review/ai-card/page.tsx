"use client";

import type { RoomGame } from "@/contracts/room";
import { AiCard } from "@/features/room/AiCard";

/**
 * Throwaway review harness: renders the AI result card with the same fixtures as
 * the reported screenshot, so the layout can be inspected without playing a round.
 */
const solved = {
  canvasId: "canvas-1",
  generation: 3,
  drawerId: "p1",
  hint: "",
  time: "0:00",
  scores: {},
  aiStatus: "correct",
  result: {
    word: "hexagon",
    aiAnswers: ["rifle", "camouflage", "hexagon"],
    aiCorrect: true,
    aiGuesses: [
      { answer: "rifle", confidence: 0.32, elapsedMs: 3630, submitted: false },
      { answer: "camouflage", confidence: 0.04, elapsedMs: 4120, submitted: false },
      { answer: "hexagon", confidence: 0.66, elapsedMs: 5140, submitted: true },
    ],
    aiBenchmark: { status: "solved" },
  },
} as unknown as RoomGame;

const missed = {
  ...solved,
  aiStatus: "wrong",
  result: {
    word: "hexagon",
    aiAnswers: ["rifle", "camouflage", "halftone pattern that keeps going"],
    aiCorrect: false,
    aiGuesses: [
      { answer: "rifle", confidence: 0.32, elapsedMs: 3400, submitted: false },
      { answer: "camouflage", confidence: 0.18, elapsedMs: 3900, submitted: true },
      { answer: "halftone pattern that keeps going", confidence: 0.09, elapsedMs: 4400, submitted: true },
    ],
    aiBenchmark: { status: "unsolved" },
  },
} as unknown as RoomGame;

export default function AiCardReview() {
  return (
    <main style={{ background: "#ffe83d", minHeight: "100vh", padding: 24, display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ width: 286 }}>
        <AiCard game={solved} result />
      </div>
      <div style={{ width: 286 }}>
        <AiCard game={missed} result />
      </div>
      <div style={{ width: 340 }}>
        <AiCard game={solved} result />
      </div>
      <div style={{ width: 250 }}>
        <AiCard game={missed} result />
      </div>
    </main>
  );
}
