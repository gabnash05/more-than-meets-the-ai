import { describe, expect, it } from "vitest";
import type { FreeDrawCapabilities } from "../../../../../packages/game-contracts/src/free-draw";
import {
  normalizeFreeDrawLabel,
  planRoles,
  predictionFromAnswer,
  shouldAnalyze,
} from "./state";
import type { FreeDrawFeature } from "./types";

const capabilities: FreeDrawCapabilities = {
  guesser: { available: true, labels: ["Cat"] },
  referee: { available: true },
  minIntervalMs: 500,
};
const allOn: Record<FreeDrawFeature, boolean> = {
  guesser: true,
  referee: true,
  heatmap: false,
};
const base = {
  toggles: allOn,
  mode: "free" as const,
  prompt: "",
  solved: false,
  capabilities,
  successfulRevision: {},
  revision: 5,
  retryAt: {},
  now: 10000,
};

describe("free draw inference planning", () => {
  it("waits for a settled, visible canvas with ink and no active observation", () => {
    expect(
      shouldAnalyze({
        loading: false,
        hidden: false,
        busy: false,
        hasInk: true,
        inFlight: false,
      }),
    ).toBe(true);
    expect(
      shouldAnalyze({
        loading: false,
        hidden: true,
        busy: false,
        hasInk: true,
        inFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldAnalyze({
        loading: false,
        hidden: false,
        busy: true,
        hasInk: true,
        inFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldAnalyze({
        loading: false,
        hidden: false,
        busy: false,
        hasInk: false,
        inFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldAnalyze({
        loading: false,
        hidden: false,
        busy: false,
        hasInk: true,
        inFlight: true,
      }),
    ).toBe(false);
  });

  it("requests both enabled roles once and retries only the failed role", () => {
    expect(planRoles(base)).toEqual(["guesser", "referee"]);
    expect(planRoles({ ...base, successfulRevision: { guesser: 5 } })).toEqual([
      "referee",
    ]);
    expect(
      planRoles({
        ...base,
        successfulRevision: { guesser: 5 },
        retryAt: { referee: 11000 },
      }),
    ).toEqual([]);
  });

  it("keeps heatmap inference available after solve without adding guesser attempts", () => {
    expect(
      planRoles({ ...base, mode: "prompt", prompt: "cat", solved: true }),
    ).toEqual(["referee"]);
    expect(
      planRoles({
        ...base,
        mode: "prompt",
        prompt: "cat",
        solved: true,
        toggles: { ...allOn, heatmap: true },
      }),
    ).toEqual(["guesser", "referee"]);
    expect(planRoles({ ...base, mode: "prompt", prompt: "" })).toEqual([
      "referee",
    ]);
    expect(
      planRoles({
        ...base,
        mode: "prompt",
        prompt: "",
        toggles: { ...allOn, heatmap: true },
      }),
    ).toEqual(["guesser", "referee"]);
  });

  it("does not repeat a successful unchanged revision and normalizes prompt labels", () => {
    expect(
      planRoles({ ...base, successfulRevision: { guesser: 5, referee: 5 } }),
    ).toEqual([]);
    expect(normalizeFreeDrawLabel("  Red   Fox ")).toBe("red fox");
    expect(normalizeFreeDrawLabel(" CAT ")).toBe(normalizeFreeDrawLabel("cat"));
  });

  it("uses strict confidence above 0.5 and only the top answer to mark prompt correctness", () => {
    expect(
      predictionFromAnswer({
        id: "a",
        answer: "cat",
        confidence: 0.5,
        mode: "prompt",
        prompt: "Cat",
      }),
    ).toMatchObject({ submitted: false });
    expect(
      predictionFromAnswer({
        id: "b",
        answer: " CAT ",
        confidence: 0.5001,
        mode: "prompt",
        prompt: "cat",
      }),
    ).toMatchObject({ submitted: true, correct: true });
    expect(
      predictionFromAnswer({
        id: "c",
        answer: "dog",
        confidence: 0.9,
        mode: "prompt",
        prompt: "cat",
      }),
    ).toMatchObject({ submitted: true, correct: false });
    expect(
      predictionFromAnswer({
        id: "d",
        answer: "cat",
        confidence: 0.9,
        mode: "free",
        prompt: "cat",
      }),
    ).not.toHaveProperty("correct");
  });
});
