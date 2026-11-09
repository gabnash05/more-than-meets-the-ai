import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { RoomGame } from "@/contracts/room";
import { AiCard } from "./AiCard";
import styles from "./AiCard.module.css";

it("keeps an unavailable legacy result from looking solved", () => {
  const game = { aiStatus: "correct", result: { aiCorrect: true, aiAnswers: ["cat"], word: "cat", deltas: {} } } as unknown as RoomGame;
  const html = renderToStaticMarkup(createElement(AiCard, { game, result: true, unavailable: true }));
  expect(html).toContain("AI unavailable");
  expect(html).not.toContain(styles.solved);
  expect(html).not.toContain("Guessed it");
});

it("reveals recorded guesses at recap after a later attempt is unavailable", () => {
  const game: RoomGame = {
    generation: 1, canvasId: "canvas", drawerId: "drawer", hint: "", time: "", scores: {},
    aiStatus: "unavailable",
    result: {
      aiBenchmark: { scoringVersion: "ai-benchmark-v1", status: "unavailable", points: null, elapsedMs: null },
      aiCorrect: false, aiAnswers: ["airplane", "boat"], word: "car", deltas: {},
    },
  };
  const live = renderToStaticMarkup(createElement(AiCard, { game, result: false, unavailable: true }));
  expect(live).toContain("AI unavailable");
  expect(live).not.toContain("boat");
  expect(live).not.toContain("airplane");

  const recap = renderToStaticMarkup(createElement(AiCard, { game, result: true, unavailable: true }));
  expect(recap).toContain("Unavailable");
  expect(recap).toContain("boat");
  expect(recap).toContain("airplane");
  expect(recap).not.toContain(styles.solved);
});
