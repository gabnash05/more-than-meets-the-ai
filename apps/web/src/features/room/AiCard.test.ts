import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { RoomGame } from "@/contracts/room";
import { AiCard, isSubmitted } from "./AiCard";
import styles from "./AiCard.module.css";

it("keeps an unavailable legacy result from looking solved", () => {
  const game = {
    aiStatus: "correct",
    result: { aiCorrect: true, aiAnswers: ["cat"], word: "cat", deltas: {} },
  } as unknown as RoomGame;
  const html = renderToStaticMarkup(
    createElement(AiCard, { game, result: true, unavailable: true }),
  );
  expect(html).toContain("AI unavailable");
  expect(html).not.toContain(styles.solved);
  expect(html).not.toContain("Guessed it");
});

it("reveals recorded guesses at recap after a later attempt is unavailable", () => {
  const game: RoomGame = {
    generation: 1,
    canvasId: "canvas",
    drawerId: "drawer",
    hint: "",
    time: "",
    scores: {},
    aiStatus: "unavailable",
    result: {
      aiBenchmark: {
        scoringVersion: "ai-benchmark-v1",
        status: "unavailable",
        points: null,
        elapsedMs: null,
      },
      aiCorrect: false,
      aiAnswers: ["airplane", "boat"],
      word: "car",
      deltas: {},
    },
  };
  const live = renderToStaticMarkup(
    createElement(AiCard, { game, result: false, unavailable: true }),
  );
  expect(live).toContain("AI unavailable");
  expect(live).not.toContain("boat");
  expect(live).not.toContain("airplane");

  const recap = renderToStaticMarkup(
    createElement(AiCard, { game, result: true, unavailable: true }),
  );
  expect(recap).toContain("Unavailable");
  expect(recap).toContain("boat");
  expect(recap).toContain("airplane");
  expect(recap).not.toContain(styles.solved);
});

it("shows rounded confidence for recap guesses while retaining legacy answer-only results", () => {
  const game: RoomGame = {
    generation: 1,
    canvasId: "canvas",
    drawerId: "drawer",
    hint: "",
    time: "",
    scores: {},
    result: {
      aiCorrect: true,
      aiAnswers: ["cat", "car"],
      aiGuesses: [
        { answer: "cat", confidence: 0.734 },
        { answer: "car", confidence: 0.956 },
      ],
      word: "car",
      deltas: {},
    },
  };
  const html = renderToStaticMarkup(
    createElement(AiCard, { game, result: true }),
  );
  expect(html).toContain("73%");
  expect(html).toContain(">96%</span>");
  expect(html).toContain("cat");
});

it("keeps the last submitted guess separate from a later low-confidence prediction", () => {
  const game = {
    result: {
      aiAnswers: ["dog", "cat"],
      aiGuesses: [
        { answer: "dog", confidence: 0.8, submitted: true, elapsedMs: 1000 },
        { answer: "cat", confidence: 0.5, submitted: false, elapsedMs: 3000 },
      ],
      finalAnswer: "cat",
      aiCorrect: false,
      word: "cat",
      deltas: {},
    },
  } as unknown as RoomGame;
  const html = renderToStaticMarkup(
    createElement(AiCard, { game, result: true }),
  );
  const final = html.slice(
    html.indexOf('data-testid="ai-final-answer"'),
    html.indexOf("All predictions"),
  );
  expect(final).toContain("dog");
  expect(final).not.toContain(">cat<");
  expect(html).toContain("Not submitted - low confidence");
  expect(html).toContain("3.0s");
  expect(html).toContain("50%");
});

it("does not invent a submitted guess when all recorded predictions were filtered", () => {
  const game = {
    result: {
      aiAnswers: [],
      aiGuesses: [{ answer: "cat", confidence: 0.4, submitted: false }],
      finalAnswer: "cat",
      aiCorrect: false,
      word: "cat",
      deltas: {},
    },
  } as unknown as RoomGame;
  const html = renderToStaticMarkup(
    createElement(AiCard, { game, result: true }),
  );
  expect(html).toContain("No submitted guess");
  expect(html).toContain("Not submitted - low confidence");
});

it("preserves accepted legacy guesses whose submission metadata is absent", () => {
  expect(isSubmitted({ answer: "cat", confidence: 0.2 })).toBe(true);
  expect(
    isSubmitted({ answer: "cat", confidence: 0.5, submitted: false }),
  ).toBe(false);
});

it("hides every prediction until the round result is explicitly revealed", () => {
  const game = {
    aiStatus: "guessing",
    result: {
      word: "target-sentinel",
      aiCorrect: false,
      aiAnswers: ["private-top-one", "private-runner-up"],
      aiGuesses: [{ answer: "private-top-one", confidence: 0.9 }],
      deltas: {},
    },
  } as unknown as RoomGame;
  const hidden = renderToStaticMarkup(
    createElement(AiCard, { game, result: false }),
  );
  expect(hidden).not.toContain("private-top-one");
  expect(hidden).not.toContain("private-runner-up");
  expect(hidden).not.toContain("target-sentinel");
  const revealed = renderToStaticMarkup(
    createElement(AiCard, { game, result: true }),
  );
  expect(revealed).toContain("private-top-one");
});
